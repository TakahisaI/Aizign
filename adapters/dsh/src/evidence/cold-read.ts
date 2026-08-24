/**
 * Cold read of harness session-log observations.
 *
 * Completion is never inferred from a live notification, idle state, or
 * prose (hard invariant 1). The reader examines a persisted top-level
 * `tool/call` / `tool/result` pair when the source provides one, and checks
 * the result's binding metadata against what this plugin instance writes.
 *
 * The source is a structural port: DSH's `SessionPersistence.readFrom`
 * satisfies it, and tests supply an in-memory log. Session ids are adapter
 * input and never leave this module toward the core.
 */

import type { SignalBinding } from '../config.ts';
import { TOOL_NAME } from '../mapping/tool.ts';
import { bindingDigest } from './digest.ts';

/** The subset of a session event this module reads. */
export interface SessionEventLike {
  readonly type: string;
  readonly seq: number;
  readonly data: unknown;
}

/** What the cold read needs from a session store. DSH's `SessionPersistence.readFrom` matches. */
export interface EvidenceSource {
  readFrom(
    sessionId: string,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ readonly events: readonly SessionEventLike[] }>;
}

/** Caller-wait and post-materialization classification guards for one session read. */
export interface ColdReadOptions {
  /** First sequence number to read. Default 0. */
  readonly fromSeq?: number;
  /** Maximum number of materialized events accepted for classification. Default 10000. */
  readonly maxEvents?: number;
  /** Wall-clock bound for the read. Default 10000 ms. */
  readonly timeoutMs?: number;
  /** Caller cancellation. */
  readonly signal?: AbortSignal;
}

export const DEFAULT_MAX_EVENTS = 10_000;
export const DEFAULT_COLD_READ_TIMEOUT_MS = 10_000;

/** Presentation metadata the tool writes into every result. */
export interface SignalResultMeta {
  readonly tool: typeof TOOL_NAME;
  readonly eventId: string;
  readonly disposition: 'accepted' | 'duplicate';
  readonly bindingDigest: string;
  readonly payloadDigest: string;
}

export type SignalEvidence =
  /** A success observation matched the event and binding metadata. */
  | {
      readonly kind: 'accepted' | 'duplicate';
      readonly eventId: string;
      readonly callSeq: number;
      readonly resultSeq: number;
      readonly payloadDigest: string;
    }
  /**
   * A persisted error result settled the call, but DSH persists only the error
   * name and code with it — no presentation metadata — so it cannot be
   * verified against this binding. `code` is diagnostic only: it may belong
   * to a submission under a different binding in the same session, and must
   * never be adopted as this binding's rejection (hard invariant 5).
   */
  | {
      readonly kind: 'unknown';
      readonly reason: 'unverified_error';
      readonly code: string;
      readonly callSeq: number;
      readonly resultSeq: number;
    }
  /** A call exists but no result settled it: the outcome is unknown. */
  | {
      readonly kind: 'unknown';
      readonly reason: 'no_result' | 'meta_mismatch';
      readonly callSeq: number;
    }
  /** Caller wait ended or the materialized event-count guard failed; nothing partial is reported. */
  | {
      readonly kind: 'unknown';
      readonly reason: 'bound_exceeded' | 'aborted';
      readonly detail: string;
    }
  /** No call for this tool in the log. */
  | { readonly kind: 'absent' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeMeta(value: unknown): SignalResultMeta | undefined {
  if (!isRecord(value)) return undefined;
  const { tool, eventId, disposition, bindingDigest: bd, payloadDigest: pd } = value;
  if (tool !== TOOL_NAME) return undefined;
  if (typeof eventId !== 'string' || typeof bd !== 'string' || typeof pd !== 'string')
    return undefined;
  if (disposition !== 'accepted' && disposition !== 'duplicate') return undefined;
  return { tool: TOOL_NAME, eventId, disposition, bindingDigest: bd, payloadDigest: pd };
}

function resultCallId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const message = data.message;
  if (!isRecord(message)) return undefined;
  const source = message.source;
  if (isRecord(source) && typeof source.callId === 'string') return source.callId;
  const content = message.content;
  if (Array.isArray(content) && isRecord(content[0]) && typeof content[0].toolCallId === 'string') {
    return content[0].toolCallId;
  }
  return undefined;
}

function resultError(data: unknown): string | undefined {
  if (!isRecord(data) || !isRecord(data.error)) return undefined;
  return typeof data.error.code === 'string' ? data.error.code : 'UNKNOWN_ERROR';
}

/**
 * Reads the session from `fromSeq` and classifies the **latest** call of our
 * tool. Earlier calls are ignored: the journal, not the log, is the
 * authority on what was accepted; this only tells the adapter whether a
 * submission it cannot remember did settle.
 *
 * A non-abort rejection from the source is propagated rather than converted
 * to `SignalEvidence`. Callers must treat that observation as unavailable and
 * must not infer success, rejection, or absence from it.
 */
export async function readSignalEvidence(
  source: EvidenceSource,
  sessionId: string,
  binding: SignalBinding,
  options: ColdReadOptions = {},
): Promise<SignalEvidence> {
  const fromSeq = options.fromSeq ?? 0;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_COLD_READ_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

  let events: readonly SessionEventLike[];
  try {
    const read = source.readFrom(sessionId, fromSeq, signal);
    const abort = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    ({ events } = await Promise.race([read, abort]));
  } catch (error) {
    if (signal.aborted) {
      const reason = timeout.aborted ? 'timed out' : 'cancelled';
      return { kind: 'unknown', reason: 'aborted', detail: `cold read ${reason}` };
    }
    throw error;
  }
  if (events.length > maxEvents) {
    return {
      kind: 'unknown',
      reason: 'bound_exceeded',
      detail: `session returned ${events.length} events; at most ${maxEvents} are read`,
    };
  }
  const calls = events.filter(
    (event) => event.type === 'tool/call' && isRecord(event.data) && event.data.name === TOOL_NAME,
  );
  const call = calls.at(-1);
  if (call === undefined || !isRecord(call.data) || typeof call.data.callId !== 'string') {
    return { kind: 'absent' };
  }
  const callId = call.data.callId;
  const result = events.find(
    (event) =>
      event.type === 'tool/result' && event.seq > call.seq && resultCallId(event.data) === callId,
  );
  if (result === undefined) return { kind: 'unknown', reason: 'no_result', callSeq: call.seq };

  const errorCode = resultError(result.data);
  if (errorCode !== undefined) {
    // Error results carry no binding metadata (the harness computes
    // presentation metadata only for successful values), so the rejection
    // cannot be attributed to this binding.
    return {
      kind: 'unknown',
      reason: 'unverified_error',
      code: errorCode,
      callSeq: call.seq,
      resultSeq: result.seq,
    };
  }
  const meta = decodeMeta(isRecord(result.data) ? result.data.meta : undefined);
  if (
    meta === undefined ||
    meta.eventId !== binding.eventId ||
    meta.bindingDigest !== bindingDigest(binding)
  ) {
    return { kind: 'unknown', reason: 'meta_mismatch', callSeq: call.seq };
  }
  return {
    kind: meta.disposition,
    eventId: meta.eventId,
    callSeq: call.seq,
    resultSeq: result.seq,
    payloadDigest: meta.payloadDigest,
  };
}
