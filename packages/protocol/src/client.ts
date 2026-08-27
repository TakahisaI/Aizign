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
   * Invalid outbound source values reject with a local `ProtocolError` before
   * timing or transport; they return no `SubmitOutcome`. The sole request
   * encoder owns both field validation and its final frame bound.
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
