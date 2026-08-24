/**
 * Before the tool is offered to any agent: can we reach the binary, and
 * does it speak our protocol with the capability we need?
 */

import {
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  type CoreClient,
  checkCompatibility,
  type HelloInfo,
  PROTOCOL_VERSION,
} from '@aizign/protocol';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { adapterCodes } from '../mapping/tool.ts';

export const REQUIRED = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
} as const;

/** Compatibility requirement for an explicit control-plane reconciliation caller. */
export const RECONCILIATION_REQUIRED = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [CAPABILITY_WORKFLOW_SIGNAL_RECONCILE],
} as const;

/** Resolves with the binary's `hello` info or throws a harness error. */
export async function preflight(client: CoreClient): Promise<HelloInfo> {
  const outcome = await client.hello('req-preflight');
  if (outcome.kind === 'unknown') {
    throw new HarnessError(
      `aizign binary unreachable (${outcome.reason}): ${outcome.detail}`,
      adapterCodes.UNAVAILABLE,
    );
  }
  if (outcome.kind === 'error') {
    throw new HarnessError(
      `aizign hello failed: ${outcome.code}: ${outcome.message}`,
      adapterCodes.UNAVAILABLE,
    );
  }
  const problem = checkCompatibility(outcome.info, REQUIRED);
  if (problem !== undefined) {
    throw new HarnessError(problem.detail, adapterCodes.INCOMPATIBLE);
  }
  return outcome.info;
}
