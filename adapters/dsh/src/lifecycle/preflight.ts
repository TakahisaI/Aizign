/**
 * Before the tool is offered to any agent: can we reach the binary, and
 * does it speak our protocol with the capability we need?
 */

import {
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  type CoreClient,
  checkCompatibility,
  emitBestEffort,
  type HelloInfo,
  isTimingErrorCode,
  type ParentTimingMeasurement,
  type ParentTimingSink,
  PROTOCOL_VERSION,
  codes as protocolCodes,
  type TimingOutcome,
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

export interface PreflightOptions {
  /** Optional metadata-only timing sink. Sink failures never fail preflight. */
  readonly timingSink?: ParentTimingSink;
}

/** Resolves with the binary's `hello` info or throws a harness error. */
export async function preflight(
  client: CoreClient,
  options: PreflightOptions = {},
): Promise<HelloInfo> {
  const started = performance.now();
  const finish = (
    outcome: TimingOutcome,
    error_code?: string,
    unknown_reason?: ParentTimingMeasurement['unknown_reason'],
  ) => {
    const safeErrorCode =
      error_code !== undefined && isTimingErrorCode(error_code) ? error_code : undefined;
    emitBestEffort(options.timingSink, {
      operation_kind: 'preflight',
      preflight_ms: performance.now() - started,
      outcome,
      ...(safeErrorCode === undefined ? {} : { error_code: safeErrorCode }),
      ...(unknown_reason === undefined ? {} : { unknown_reason }),
    });
  };
  const outcome = await client.hello('req-preflight');
  if (outcome.kind === 'unknown') {
    finish('unknown', outcome.reportedCode, outcome.reason);
    throw new HarnessError(
      `aizign binary unreachable (${outcome.reason}): ${outcome.detail}`,
      adapterCodes.UNAVAILABLE,
    );
  }
  if (outcome.kind === 'error') {
    finish('error', outcome.code);
    throw new HarnessError(
      `aizign hello failed: ${outcome.code}: ${outcome.message}`,
      adapterCodes.UNAVAILABLE,
    );
  }
  const problem = checkCompatibility(outcome.info, REQUIRED);
  if (problem !== undefined) {
    finish(
      'rejected',
      problem.reason === 'protocol_version'
        ? protocolCodes.PROTOCOL_VERSION_UNSUPPORTED
        : protocolCodes.CAPABILITY_UNSUPPORTED,
    );
    throw new HarnessError(problem.detail, adapterCodes.INCOMPATIBLE);
  }
  finish('ok');
  return outcome.info;
}
