/**
 * The `submit_workflow_signal` tool as the agent sees it: scope-bound. The
 * agent supplies only what it can know (kind, finding count, artifact
 * reference, short error code); the control plane fixed the identity in the
 * plugin configuration, so it never appears in the input parameter schema,
 * arguments, or prompt. The successful result discloses the fixed `eventId`
 * for correlation, but the agent cannot select or alter it.
 */

import { randomUUID } from 'node:crypto';
import {
  type CoreClient,
  ProtocolError,
  type Role,
  type SignalKind,
  type SubmitOutcome,
  type WorkflowSignalSubmitPayload,
} from '@aizign/protocol';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { bindingPayload, type SignalBinding } from '../config.ts';
import { bindingDigest, payloadDigest } from '../evidence/digest.ts';

export const TOOL_NAME = 'submit_workflow_signal';

/** Harness-facing codes this adapter raises, besides the protocol's own. */
export const adapterCodes = {
  /** The core reported neither success nor rejection; do not retry. */
  OUTCOME_UNKNOWN: 'AIZIGN_OUTCOME_UNKNOWN',
  /** The `aizign` binary could not be reached for the handshake. */
  UNAVAILABLE: 'AIZIGN_UNAVAILABLE',
  /** The binary speaks another protocol version or lacks a capability. */
  INCOMPATIBLE: 'AIZIGN_INCOMPATIBLE',
} as const;

const REJECTED_TOOL_MESSAGE = 'Aizign rejected the workflow signal';
const UNKNOWN_TOOL_MESSAGE = 'Aizign could not determine the workflow signal outcome';
const INVALID_TOOL_INPUT_MESSAGE = 'Aizign rejected invalid workflow signal input';

/** Kinds a role may submit; `blocked` is always allowed. */
export function kindsForRole(role: Role): readonly SignalKind[] {
  return role === 'implementation'
    ? ['implementation_ready', 'repair_submitted', 'blocked']
    : ['review_passed', 'review_findings', 'blocked'];
}

/** The closed argument schema: no identity fields, ever. */
export function toolParameters(role: Role): Record<string, unknown> {
  const schema: JsonSchemaNode = {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: [...kindsForRole(role)] },
      findingCount: { type: 'integer', description: 'Non-negative count of findings' },
      artifactRef: { type: 'string' },
      shortErrorCode: { type: 'string' },
    },
    required: ['kind'],
  };
  return { ...schema };
}

const TOOL_OUTPUT: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    disposition: { type: 'string', enum: ['accepted', 'duplicate'] },
    eventId: { type: 'string' },
  },
  required: ['disposition', 'eventId'],
};

/** What the agent is allowed to say. */
export interface SignalArgs {
  readonly kind: SignalKind;
  readonly findingCount?: number;
  readonly artifactRef?: string;
  readonly shortErrorCode?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Closed decode of the agent's arguments; anything else is `INVALID_SIGNAL`. */
export function decodeArgs(args: unknown, role: Role): SignalArgs {
  const fail = () => new HarnessError(INVALID_TOOL_INPUT_MESSAGE, 'INVALID_SIGNAL');
  if (!isPlainObject(args)) throw fail();
  for (const key of Object.keys(args)) {
    if (!['kind', 'findingCount', 'artifactRef', 'shortErrorCode'].includes(key)) {
      throw fail();
    }
  }
  const { kind, findingCount, artifactRef, shortErrorCode } = args;
  if (typeof kind !== 'string' || !(kindsForRole(role) as readonly string[]).includes(kind)) {
    throw fail();
  }
  if (
    findingCount !== undefined &&
    (!Number.isInteger(findingCount) || (findingCount as number) < 0)
  ) {
    throw fail();
  }
  if (artifactRef !== undefined && typeof artifactRef !== 'string') throw fail();
  if (shortErrorCode !== undefined && typeof shortErrorCode !== 'string') {
    throw fail();
  }
  const decoded: { -readonly [K in keyof SignalArgs]: SignalArgs[K] } = {
    kind: kind as SignalKind,
  };
  if (findingCount !== undefined) decoded.findingCount = findingCount as number;
  if (artifactRef !== undefined) decoded.artifactRef = artifactRef;
  if (shortErrorCode !== undefined) decoded.shortErrorCode = shortErrorCode;
  return decoded;
}

/**
 * Binds the agent's arguments to the configured identity. Harness-local input
 * validation stays here; Protocol source validation belongs exclusively to
 * the client's `encodeRequest` boundary.
 */
export function toPayload(binding: SignalBinding, args: SignalArgs): WorkflowSignalSubmitPayload {
  return bindingPayload(binding, args);
}

/**
 * A fresh, adapter-owned request id. Deliberately unrelated to the harness
 * call id: nothing harness-specific crosses the process boundary, not even
 * in the envelope (data boundary, hard invariant 8).
 */
export function newRequestId(): string {
  return `req-${randomUUID()}`;
}

/**
 * Maps the core's answer to the tool's canonical value or a harness error.
 *
 * Protocol diagnostics are control-plane data and can contain state paths or
 * operating-system detail. Preserve only the stable code at this model-facing
 * boundary; never forward the peer's human-readable message or unknown detail.
 */
export function toToolResult(outcome: SubmitOutcome): {
  disposition: 'accepted' | 'duplicate';
  eventId: string;
} {
  switch (outcome.kind) {
    case 'accepted':
    case 'duplicate':
      return { disposition: outcome.kind, eventId: outcome.eventId };
    case 'rejected':
      throw new HarnessError(REJECTED_TOOL_MESSAGE, outcome.code);
    case 'unknown':
      // Never retried here: the core may have appended. Reconciliation is a
      // separate, explicit step.
      throw new HarnessError(UNKNOWN_TOOL_MESSAGE, adapterCodes.OUTCOME_UNKNOWN);
  }
}

/**
 * Presentation metadata written to the harness `tool/result`: identity and
 * digests only. A later session read verifies the event and binding metadata
 * and reports the recorded payload digest (see `evidence/cold-read.ts`). This
 * type makes no durability or retention claim. Must be total and pure.
 */
export interface SignalPresentationMeta {
  tool: string;
  eventId: string;
  disposition: 'accepted' | 'duplicate' | null;
  bindingDigest: string;
  payloadDigest: string;
}

export function presentationMetaFor(
  binding: SignalBinding,
  args: unknown,
  value: unknown,
): SignalPresentationMeta {
  const disposition =
    isPlainObject(value) && (value.disposition === 'accepted' || value.disposition === 'duplicate')
      ? value.disposition
      : null;
  let digest = '';
  try {
    digest = payloadDigest(toPayload(binding, decodeArgs(args, binding.expected.role)).signal);
  } catch {
    // Unreachable for a successful result; keep the callback total.
  }
  return {
    tool: TOOL_NAME,
    eventId: binding.eventId,
    disposition,
    bindingDigest: bindingDigest(binding),
    payloadDigest: digest,
  };
}

/** Builds the registered tool. */
export function createSubmitWorkflowSignalTool(
  client: CoreClient,
  binding: SignalBinding,
): ToolDefinition {
  const role = binding.expected.role;
  return {
    name: TOOL_NAME,
    description:
      'Submit the terminal result of your assignment as structured metadata. Workflow identity is fixed by the control plane. Never include prompts, model output, reasoning, logs, environment, or credentials.',
    parameters: toolParameters(role),
    output: {
      schema: TOOL_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (args, value) => ({ ...presentationMetaFor(binding, args, value) }),
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const payload = toPayload(binding, decodeArgs(args, role));
      let outcome: SubmitOutcome;
      try {
        outcome = await client.submitWorkflowSignal(newRequestId(), payload, {
          signal: exec.signal,
        });
      } catch (error) {
        if (error instanceof ProtocolError) {
          // Protocol source failures are local diagnostics. Preserve only the
          // stable code at the model boundary and never retain the cause.
          throw new HarnessError(INVALID_TOOL_INPUT_MESSAGE, error.code);
        }
        throw error;
      }
      return toToolResult(outcome);
    },
  };
}
