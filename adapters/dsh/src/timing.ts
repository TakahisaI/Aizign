/** DSH-owned metadata-only parent timing. This is not a Protocol contract. */

import { codes, type UnknownOutcome } from '@aizign/protocol';

export type ParentOperationKind =
  | 'hello'
  | 'workflow.signal.submit'
  | 'workflow.signal.reconcile'
  | 'preflight';

export type TimingOutcome =
  | 'ok'
  | 'accepted'
  | 'duplicate'
  | 'conflict'
  | 'absent'
  | 'rejected'
  | 'error'
  | 'unknown';

export interface ParentTimingMeasurement {
  readonly operation_kind: ParentOperationKind;
  readonly spawn_to_exit_ms?: number;
  readonly response_first_byte_ms?: number;
  readonly preflight_ms?: number;
  readonly outcome: TimingOutcome;
  readonly error_code?: string;
  readonly unknown_reason?: UnknownOutcome['reason'];
}

export type TimingSink<T> = (measurement: T) => void | Promise<void>;

export type ParentTimingSink = TimingSink<ParentTimingMeasurement>;

export function emitBestEffort<T>(sink: TimingSink<T> | undefined, measurement: T): void {
  if (sink === undefined) return;
  try {
    void Promise.resolve(sink(measurement)).catch(() => undefined);
  } catch {
    // Synchronous sink failures are deliberately isolated too.
  }
}

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

const TIMING_ERROR_CODES = new Set<string>(Object.values(codes));

/** Whether a fixed peer code may enter DSH's metadata-only timing channel. */
export function isTimingErrorCode(code: string): boolean {
  return TIMING_ERROR_CODES.has(code);
}
