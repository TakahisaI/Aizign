/**
 * The adapter-side contract for talking to the core. Every harness adapter
 * implements `CoreClient`; `@aizu/adapter-testkit` proves an implementation
 * behaves correctly against a fake core process, including the cases where
 * the outcome is unknown.
 */

import type { HelloInfo } from './hello.ts';
import type { SignalResult, WorkflowSignalSubmitPayload } from './workflow-signal.ts';

/** How to reach the `aizu` binary. */
export interface CoreClientConfig {
  /** Executable to spawn (the `aizu` binary, or `node` for a fake). */
  readonly command: string;
  /** Arguments placed before the subcommand (e.g. a script path for `node`). */
  readonly args?: readonly string[];
  /** Extra environment for the child; the parent environment is not inherited wholesale. */
  readonly env?: Readonly<Record<string, string>>;
  /** The `--state` directory. */
  readonly stateDir: string;
  /** Wall-clock bound per request; expiry is an unknown outcome, not a retry. */
  readonly timeoutMs: number;
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
    | 'timeout'
    | 'spawn_failed'
    | 'reported_unknown';
  readonly detail: string;
}

export type HelloOutcome =
  | { readonly kind: 'ok'; readonly info: HelloInfo }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }
  | UnknownOutcome;

export type SubmitOutcome =
  | { readonly kind: 'accepted' | 'duplicate'; readonly eventId: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | UnknownOutcome;

/** One-shot request/response against the core. */
export interface CoreClient {
  hello(requestId: string): Promise<HelloOutcome>;
  submitWorkflowSignal(
    requestId: string,
    payload: WorkflowSignalSubmitPayload,
  ): Promise<SubmitOutcome>;
}

export type { HelloInfo, SignalResult, WorkflowSignalSubmitPayload };
