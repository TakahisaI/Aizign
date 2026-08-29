import { createHash } from 'node:crypto';
import type { WorkflowSignalSubmitPayload } from '@aizign/protocol';
import type { SignalBinding, TrustedSignalValues } from '../config.ts';
import type { SignalArgs } from './tool.ts';

export interface TrustedValueResolution {
  readonly payload: WorkflowSignalSubmitPayload;
  readonly trustedValueMappingKey: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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
