/**
 * The TypeScript reference operation surface for talking to the core. It
 * includes signal submission and reconciliation. TypeScript adapters may use
 * `@aizign/adapter-testkit` to exercise this client boundary against a fake
 * core process, including the cases where the outcome is unknown. Implementing
 * this interface does not establish harness-adapter conformance.
 */

import type { Response } from './envelope.ts';
import type { HelloInfo } from './hello.ts';
import type {
  ReconciliationResult,
  SignalResult,
  WorkflowSignalReconcilePayload,
  WorkflowSignalSubmitPayload,
} from './workflow-signal.ts';

/** How to reach the `aizign` binary. */
export interface CoreClientConfig {
  /** Executable to spawn (the `aizign` binary, or `node` for a fake). */
  readonly command: string;
  /** Arguments placed before the subcommand (e.g. a script path for `node`). */
  readonly args?: readonly string[];
  /** Extra environment for the child; the parent environment is not inherited wholesale. */
  readonly env?: Readonly<Record<string, string>>;
  /** The `--state` directory. */
  readonly stateDir: string;
  /** Wall-clock bound per request; expiry is an unknown outcome, not a retry. */
  readonly timeoutMs: number;
  /** Optional metadata-only parent timing sink. Sink failures are ignored. */
  readonly timingSink?: ParentTimingSink;
}

/** Parent-observed operation names shared by reference and harness clients. */
export type ParentOperationKind =
  | 'hello'
  | 'workflow.signal.submit'
  | 'workflow.signal.reconcile'
  | 'preflight';

/** Closed outcome vocabulary shared by metadata-only timing observations. */
export type TimingOutcome =
  | 'ok'
  | 'accepted'
  | 'duplicate'
  | 'conflict'
  | 'absent'
  | 'rejected'
  | 'error'
  | 'unknown';

/** One metadata-only parent observation. Content, identity, and paths are excluded. */
export interface ParentTimingMeasurement {
  readonly operation_kind: ParentOperationKind;
  /** Spawn invocation until the child `exit` event. Absent when no exit was observed. */
  readonly spawn_to_exit_ms?: number;
  /** Spawn invocation until first stdout byte. The CLI writes one complete response, not a stream. */
  readonly response_first_byte_ms?: number;
  /** Whole compatibility preflight. Present only for the `preflight` operation. */
  readonly preflight_ms?: number;
  readonly outcome: TimingOutcome;
  readonly error_code?: string;
  readonly unknown_reason?: UnknownOutcome['reason'];
}

/** A best-effort timing destination. Both synchronous and asynchronous failures are ignored. */
export type TimingSink<T> = (measurement: T) => void | Promise<void>;

/** Receives a parent timing observation. Implementations must use {@link emitBestEffort}. */
export type ParentTimingSink = TimingSink<ParentTimingMeasurement>;

/** Emits one observation without allowing a synchronous throw or rejected promise to escape. */
export function emitBestEffort<T>(sink: TimingSink<T> | undefined, measurement: T): void {
  if (sink === undefined) return;
  try {
    void Promise.resolve(sink(measurement)).catch(() => undefined);
  } catch {
    // Synchronous sink failures are deliberately isolated too.
  }
}

/** Maps a returned semantic outcome to the closed parent timing vocabulary. */
export function parentTimingOutcome(
  operationKind: ParentOperationKind,
  outcomeKind: TimingOutcome,
  errorCode?: string,
): TimingOutcome {
  if (outcomeKind === 'unknown') return 'unknown';
  if (
    operationKind === 'workflow.signal.submit' &&
    outcomeKind === 'rejected' &&
    errorCode === 'EVENT_CONFLICT'
  ) {
    return 'conflict';
  }
  return outcomeKind;
}

/**
 * Error codes that mean "the outcome is unknown", not "the request was
 * rejected". A client must surface them as {@link UnknownOutcome}.
 */
export const UNKNOWN_OUTCOME_CODES: readonly string[] = [
  'JOURNAL_OUTCOME_UNKNOWN',
  'HANDLER_TIMEOUT',
  'EFFECT_OUTCOME_UNKNOWN',
];

export function isUnknownOutcomeCode(code: string): boolean {
  return UNKNOWN_OUTCOME_CODES.includes(code);
}

/**
 * Codes that definitively reject `workflow.signal.submit` before acceptance.
 * This set is intentionally closed: a well-formed but unrecognized peer code
 * is an unknown outcome until this client understands its semantics.
 */
export const SUBMIT_REJECTION_CODES: readonly string[] = [
  'PROTOCOL_VERSION_UNSUPPORTED',
  'INVALID_ENVELOPE',
  'UNKNOWN_KIND',
  'INVALID_PAYLOAD',
  'REQUEST_TOO_LARGE',
  'CAPABILITY_UNSUPPORTED',
  'INVALID_EXPECTATION',
  'INVALID_SIGNAL',
  'WORKFLOW_MISMATCH',
  'ASSIGNMENT_MISMATCH',
  'ATTEMPT_MISMATCH',
  'ROLE_MISMATCH',
  'REVISION_MISMATCH',
  'CANDIDATE_DIGEST_MISMATCH',
  'EVENT_CONFLICT',
  'JOURNAL_UNAVAILABLE',
  'JOURNAL_CORRUPT',
  'JOURNAL_SCHEMA_UNSUPPORTED',
  'JOURNAL_LOCKED',
  'JOURNAL_BOUND_EXCEEDED',
];

/** Whether `code` is a known definitive rejection for signal submission. */
export function isSubmitRejectionCode(code: string): boolean {
  return SUBMIT_REJECTION_CODES.includes(code);
}

/** A result whose truth the adapter could not establish. Never retry it blindly. */
export interface UnknownOutcome {
  readonly kind: 'unknown';
  /**
   * Why: the process exited without a frame, the frame was undecodable, the
   * wall-clock bound expired, the process could not be spawned, or the core
   * itself reported an unknown-outcome code.
   */
  readonly reason:
    | 'no_response'
    | 'undecodable_response'
    | 'oversized_response'
    | 'correlation_mismatch'
    | 'timeout'
    | 'spawn_failed'
    | 'reported_unknown'
    | 'aborted';
  readonly detail: string;
  /**
   * A syntactically valid peer code retained for control-plane diagnostics.
   * It does not prove a semantic classification and must not cross a
   * model-facing boundary as a harness error code.
   */
  readonly reportedCode?: string;
}

/** An indeterminate reconciliation, with any valid reported code retained diagnostically. */
export interface ReconcileUnknown extends UnknownOutcome {
  readonly reportedCode?: string;
}

/** What a client sent, for correlating the response against it. */
export interface SentRequest {
  readonly requestId: string;
  readonly kind: string;
  /** For workflow signal submit/reconcile: the queried signal's event id. */
  readonly eventId?: string;
}

export interface CorrelationMismatch {
  readonly field: 'requestId' | 'kind' | 'eventId';
  readonly expected: string;
  readonly actual: string | null;
}

/**
 * A response is only evidence about the request it answers. Any mismatch
 * means the client cannot know what happened to its own request — the
 * effect may already have been applied — so callers must treat a mismatch
 * as an unknown outcome, never as a rejection.
 */
export function checkCorrelation(
  sent: SentRequest,
  response: Response,
): CorrelationMismatch | undefined {
  if (response.requestId !== sent.requestId) {
    return { field: 'requestId', expected: sent.requestId, actual: response.requestId };
  }
  if (response.kind !== sent.kind) {
    return { field: 'kind', expected: sent.kind, actual: response.kind };
  }
  if (
    sent.eventId !== undefined &&
    (response.body.type === 'workflow.signal' ||
      response.body.type === 'workflow.signal.reconciliation')
  ) {
    const actual = response.body.result.eventId;
    if (actual !== sent.eventId) return { field: 'eventId', expected: sent.eventId, actual };
  }
  return undefined;
}

/** Per-call options. */
export interface CallOptions {
  /** Cancels the wait (the process is killed); the outcome becomes unknown. */
  readonly signal?: AbortSignal;
}

export type HelloOutcome =
  | { readonly kind: 'ok'; readonly info: HelloInfo }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }
  | UnknownOutcome;

export type SubmitOutcome =
  | { readonly kind: 'accepted' | 'duplicate'; readonly eventId: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | UnknownOutcome;

export type ReconcileOutcome =
  | {
      readonly kind: ReconciliationResult['disposition'];
      readonly eventId: string;
    }
  | ReconcileUnknown;

/** One-shot request/response against the core. */
export interface CoreClient {
  hello(requestId: string, options?: CallOptions): Promise<HelloOutcome>;
  /**
   * An outbound frame above `MAX_REQUEST_BYTES` rejects with
   * `ProtocolError(REQUEST_TOO_LARGE)` before spawn; it returns no
   * `SubmitOutcome`.
   */
  submitWorkflowSignal(
    requestId: string,
    payload: WorkflowSignalSubmitPayload,
    options?: CallOptions,
  ): Promise<SubmitOutcome>;
  reconcileWorkflowSignal(
    requestId: string,
    payload: WorkflowSignalReconcilePayload,
    options?: CallOptions,
  ): Promise<ReconcileOutcome>;
}

export type {
  HelloInfo,
  ReconciliationResult,
  SignalResult,
  WorkflowSignalReconcilePayload,
  WorkflowSignalSubmitPayload,
};
