/**
 * Digests that bind durable tool evidence to the control plane's identity.
 * Computed here and recorded in the tool result's presentation metadata, so
 * a later cold read of the harness log can be checked against the plugin
 * configuration without trusting the log's prose.
 */

import { createHash } from 'node:crypto';
import type { ExpectedAssignment, WorkflowSignal } from '@aizign/protocol';
import type { SignalBinding } from '../config.ts';

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Digest of the identity a plugin instance is bound to. */
export function bindingDigest(binding: SignalBinding): string {
  const identity: ExpectedAssignment & { eventId: string } = {
    ...binding.expected,
    eventId: binding.eventId,
  };
  return sha256Hex(canonicalJson(identity));
}

/** Digest of the full signal as submitted to the core. */
export function payloadDigest(signal: WorkflowSignal): string {
  return sha256Hex(canonicalJson(signal));
}
