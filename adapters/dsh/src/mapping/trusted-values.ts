import type { WorkflowSignalSubmitPayload } from '@aizign/protocol';
import type { SignalBinding, TrustedSignalValues } from '../config.ts';
import { canonicalJson, sha256Hex } from '../evidence/digest.ts';
import type { SignalArgs } from './tool.ts';

export interface TrustedValueResolution {
  readonly payload: WorkflowSignalSubmitPayload;
  readonly trustedValueMappingKey: string;
}

/**
 * The sole adapter mapping from model-selected signal shape plus trusted
 * control-plane values to a Protocol payload and provenance key.
 */
export function resolveTrustedSignalValues(
  binding: SignalBinding,
  trustedSignalValues: TrustedSignalValues,
  args: SignalArgs,
): TrustedValueResolution {
  const signal: WorkflowSignalSubmitPayload['signal'] = {
    ...binding.expected,
    eventId: binding.eventId,
    kind: args.kind,
    ...(args.findingCount === undefined ? {} : { findingCount: args.findingCount }),
    ...(args.kind === 'repair_submitted' || args.kind === 'review_findings'
      ? trustedSignalValues.artifactRef === undefined
        ? {}
        : { artifactRef: trustedSignalValues.artifactRef }
      : {}),
    ...(args.kind === 'blocked'
      ? { shortErrorCode: trustedSignalValues.blockedShortErrorCode }
      : {}),
  };
  const mappingRecord = {
    schemaVersion: 1,
    eventId: binding.eventId,
    expected: binding.expected,
    artifactRef: trustedSignalValues.artifactRef ?? null,
    blockedShortErrorCode: trustedSignalValues.blockedShortErrorCode,
  };
  return {
    payload: { expected: binding.expected, signal },
    trustedValueMappingKey: sha256Hex(
      `aizign:dsh:trusted-signal-values:v1\n${canonicalJson(mappingRecord)}`,
    ),
  };
}
