/**
 * The `submit_workflow_signal` tool as the agent sees it: scope-bound. The
 * agent supplies only what it can know (kind, finding count, artifact
 * reference, short error code); the control plane fixed the identity in the
 * plugin configuration, so it never appears in the schema, the arguments,
 * or the prompt.
 */

import {
  type CoreClient,
  decodeWorkflowSignalSubmit,
  encodeWorkflowSignalSubmit,
  ProtocolError,
  type Role,
  type SignalKind,
  type SubmitOutcome,
  type WorkflowSignalSubmitPayload,
} from '@aizu/protocol';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { bindingPayload, type SignalBinding } from '../config.ts';
import { bindingDigest, payloadDigest } from '../evidence/digest.ts';

export const TOOL_NAME = 'submit_workflow_signal';

/** Harness-facing codes this adapter raises, besides the protocol's own. */
export const adapterCodes = {
  /** The core reported neither success nor rejection; do not retry. */
  OUTCOME_UNKNOWN: 'AIZU_OUTCOME_UNKNOWN',
  /** The `aizu` binary could not be reached for the handshake. */
  UNAVAILABLE: 'AIZU_UNAVAILABLE',
  /** The binary speaks another protocol version or lacks a capability. */
  INCOMPATIBLE: 'AIZU_INCOMPATIBLE',
} as const;

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
  const fail = (message: string) => new HarnessError(message, 'INVALID_SIGNAL');
  if (!isPlainObject(args)) throw fail('arguments must be an object');
  for (const key of Object.keys(args)) {
    if (!['kind', 'findingCount', 'artifactRef', 'shortErrorCode'].includes(key)) {
      throw fail(`unknown argument \`${key}\``);
    }
  }
  const { kind, findingCount, artifactRef, shortErrorCode } = args;
  if (typeof kind !== 'string' || !(kindsForRole(role) as readonly string[]).includes(kind)) {
    throw fail(`kind must be one of ${kindsForRole(role).join(', ')}`);
  }
  if (
    findingCount !== undefined &&
    (!Number.isInteger(findingCount) || (findingCount as number) < 0)
  ) {
    throw fail('findingCount must be a non-negative integer');
  }
  if (artifactRef !== undefined && typeof artifactRef !== 'string')
    throw fail('artifactRef must be a string');
  if (shortErrorCode !== undefined && typeof shortErrorCode !== 'string') {
    throw fail('shortErrorCode must be a string');
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
 * Binds the agent's arguments to the configured identity and validates the
 * result with the same rules the core applies, before any process is spawned.
 */
export function toPayload(binding: SignalBinding, args: SignalArgs): WorkflowSignalSubmitPayload {
  const payload = bindingPayload(binding, args);
  try {
    return decodeWorkflowSignalSubmit(encodeWorkflowSignalSubmit(payload));
  } catch (error) {
    if (error instanceof ProtocolError)
      throw new HarnessError(error.message, error.code, { cause: error });
    throw error;
  }
}

/** A request id derived from the harness call id, within the identifier pattern. */
export function requestIdFor(callId: string): string {
  const safe = callId.replace(/[^A-Za-z0-9._:-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  return `req-${safe.length === 0 ? 'call' : safe}`.slice(0, 128);
}

/** Maps the core's answer to the tool's canonical value or a harness error. */
export function toToolResult(outcome: SubmitOutcome): {
  disposition: 'accepted' | 'duplicate';
  eventId: string;
} {
  switch (outcome.kind) {
    case 'accepted':
    case 'duplicate':
      return { disposition: outcome.kind, eventId: outcome.eventId };
    case 'rejected':
      throw new HarnessError(outcome.message, outcome.code);
    case 'unknown':
      // Never retried here: the core may have appended. Reconciliation is a
      // separate, explicit step.
      throw new HarnessError(
        `outcome unknown (${outcome.reason}): ${outcome.detail}`,
        adapterCodes.OUTCOME_UNKNOWN,
      );
  }
}

/**
 * Presentation metadata recorded in the durable `tool/result`: identity and
 * digests only, so a cold read of the session log can be checked against the
 * plugin configuration (see `evidence/cold-read.ts`). Must be total and pure.
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
      const outcome = await client.submitWorkflowSignal(requestIdFor(exec.callId), payload, {
        signal: exec.signal,
      });
      return toToolResult(outcome);
    },
  };
}
