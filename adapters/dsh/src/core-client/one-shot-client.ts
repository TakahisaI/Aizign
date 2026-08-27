/**
 * This adapter's `CoreClient`: spawn `aizign`, write one frame, read one
 * frame, classify everything else as unknown. No retries anywhere.
 */

import { spawn } from 'node:child_process';
import {
  type CallOptions,
  type CoreClient,
  checkCorrelation,
  codes,
  decodeResponse,
  encodeRequest,
  type HelloOutcome,
  MAX_FRAME_BYTES,
  OneShotFrameCollector,
  type ReconcileOutcome,
  type ReconcileUnknown,
  type Response,
  type SentRequest,
  type SubmitOutcome,
  type UnknownOutcome,
  type WorkflowSignalReconcilePayload,
  type WorkflowSignalSubmitPayload,
} from '@aizign/protocol';
import {
  emitBestEffort,
  isTimingErrorCode,
  type ParentOperationKind,
  type ParentTimingMeasurement,
  type ParentTimingSink,
  parentTimingOutcome,
  type TimingOutcome,
} from '../timing.ts';

/** DSH-owned configuration for one direct child process per Protocol operation. */
export interface OneShotCoreClientConfig {
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stateDir: string;
  readonly timeoutMs: number;
  readonly timingSink?: ParentTimingSink;
}

type TransportTiming = Pick<ParentTimingMeasurement, 'spawn_to_exit_ms' | 'response_first_byte_ms'>;

type Exchange =
  | { readonly kind: 'response'; readonly response: Response; readonly timing: TransportTiming }
  | {
      readonly kind: 'unknown';
      readonly outcome: UnknownOutcome;
      readonly timing: TransportTiming;
    };

function unknown(
  reason: UnknownOutcome['reason'],
  detail: string,
  timing: TransportTiming = {},
): Exchange {
  return { kind: 'unknown', outcome: { kind: 'unknown', reason, detail }, timing };
}

function reportedUnknown(code: string, message: string): UnknownOutcome {
  return {
    kind: 'unknown',
    reason: 'reported_unknown',
    reportedCode: code,
    detail: `${code}: ${message}`,
  };
}

function versionAxisMismatch(
  response: Response,
  expected: Response['version']['axis'],
): UnknownOutcome | undefined {
  if (response.version.axis === expected) return undefined;
  return {
    kind: 'unknown',
    reason: 'undecodable_response',
    detail: `response used ${response.version.axis} version axis; expected ${expected}`,
  };
}

const CURRENT_FIXED_ERROR_CODES = new Set<string>(Object.values(codes));
const CURRENT_UNKNOWN_OUTCOME_CODES = new Set<string>([
  codes.INTERNAL,
  codes.HANDLER_TIMEOUT,
  codes.JOURNAL_OUTCOME_UNKNOWN,
]);

type CurrentOperationKind = Exclude<ParentOperationKind, 'preflight'>;
type CorrelatedResponseCase =
  | {
      readonly kind: 'success';
      readonly disposition: 'ok' | 'accepted' | 'duplicate' | 'conflict' | 'absent';
    }
  | { readonly kind: 'error' };

/** Minimal production projection exhaustively checked against the corpus. */
export function classifyCorrelatedOutcome(
  operation: CurrentOperationKind,
  responseCase: CorrelatedResponseCase,
  reportedCode?: string,
): TimingOutcome {
  if (responseCase.kind === 'success') return responseCase.disposition;
  if (
    reportedCode === undefined ||
    !CURRENT_FIXED_ERROR_CODES.has(reportedCode) ||
    CURRENT_UNKNOWN_OUTCOME_CODES.has(reportedCode)
  ) {
    return 'unknown';
  }
  if (operation === 'hello') return 'error';
  if (operation === 'workflow.signal.submit') return 'rejected';
  return 'unknown';
}

export class OneShotCoreClient implements CoreClient {
  readonly #config: OneShotCoreClientConfig;

  constructor(config: OneShotCoreClientConfig) {
    this.#config = config;
  }

  async hello(requestId: string, options: CallOptions = {}): Promise<HelloOutcome> {
    const frame = encodeRequest({ requestId, kind: 'hello' });
    const exchange = await this.#exchange(frame, 'bootstrap', options.signal);
    const finish = (outcome: HelloOutcome, reportedErrorCode?: string) =>
      this.#finish('hello', exchange.timing, outcome, reportedErrorCode);
    if (exchange.kind === 'unknown') return finish(exchange.outcome);
    const mismatch = checkCorrelation({ requestId, kind: 'hello' }, exchange.response);
    if (mismatch !== undefined) {
      return finish({
        kind: 'unknown',
        reason: 'correlation_mismatch',
        detail: `${mismatch.field}: expected ${mismatch.expected}, got ${String(mismatch.actual)}`,
      });
    }
    const wrongAxis = versionAxisMismatch(exchange.response, 'bootstrap');
    if (wrongAxis !== undefined) return finish(wrongAxis);
    const { body } = exchange.response;
    switch (body.type) {
      case 'hello':
        return finish({
          kind: classifyCorrelatedOutcome('hello', {
            kind: 'success',
            disposition: 'ok',
          }) as 'ok',
          info: body.info,
        });
      case 'error':
        return finish(
          classifyCorrelatedOutcome('hello', { kind: 'error' }, body.error.code) === 'error'
            ? { kind: 'error', code: body.error.code, message: body.error.message }
            : reportedUnknown(body.error.code, body.error.message),
          body.error.code,
        );
      default:
        return finish({
          kind: 'unknown',
          reason: 'undecodable_response',
          detail: 'hello answered with a non-hello body',
        });
    }
  }

  async submitWorkflowSignal(
    requestId: string,
    payload: WorkflowSignalSubmitPayload,
    options: CallOptions = {},
  ): Promise<SubmitOutcome> {
    const frame = encodeRequest({ requestId, kind: 'workflow.signal.submit', payload });
    const exchange = await this.#exchange(frame, 'accepted-operation', options.signal);
    const finish = (outcome: SubmitOutcome, reportedErrorCode?: string) =>
      this.#finish('workflow.signal.submit', exchange.timing, outcome, reportedErrorCode);
    if (exchange.kind === 'unknown') return finish(exchange.outcome);
    const sent: SentRequest = {
      requestId,
      kind: 'workflow.signal.submit',
      eventId: payload.signal.eventId,
    };
    const reportedCode =
      exchange.response.body.type === 'error' ? exchange.response.body.error.code : undefined;
    const mismatch = checkCorrelation(sent, exchange.response);
    if (mismatch !== undefined) {
      return finish({
        kind: 'unknown',
        reason: 'correlation_mismatch',
        detail: `${mismatch.field}: expected ${mismatch.expected}, got ${String(mismatch.actual)}`,
        ...(reportedCode === undefined ? {} : { reportedCode }),
      });
    }
    const wrongAxis = versionAxisMismatch(exchange.response, 'accepted-operation');
    if (wrongAxis !== undefined) return finish(wrongAxis, reportedCode);
    const { body } = exchange.response;
    switch (body.type) {
      case 'workflow.signal':
        return finish({
          kind: classifyCorrelatedOutcome('workflow.signal.submit', {
            kind: 'success',
            disposition: body.result.disposition,
          }) as 'accepted' | 'duplicate',
          eventId: body.result.eventId,
        });
      case 'error':
        return finish(
          classifyCorrelatedOutcome(
            'workflow.signal.submit',
            { kind: 'error' },
            body.error.code,
          ) === 'rejected'
            ? { kind: 'rejected', code: body.error.code, message: body.error.message }
            : reportedUnknown(body.error.code, body.error.message),
          body.error.code,
        );
      default:
        return finish({
          kind: 'unknown',
          reason: 'undecodable_response',
          detail: 'submit answered with a non-signal body',
        });
    }
  }

  async reconcileWorkflowSignal(
    requestId: string,
    payload: WorkflowSignalReconcilePayload,
    options: CallOptions = {},
  ): Promise<ReconcileOutcome> {
    const frame = encodeRequest({ requestId, kind: 'workflow.signal.reconcile', payload });
    const exchange = await this.#exchange(frame, 'accepted-operation', options.signal);
    const finish = (outcome: ReconcileOutcome) =>
      this.#finish('workflow.signal.reconcile', exchange.timing, outcome);
    if (exchange.kind === 'unknown') return finish(exchange.outcome);

    const reportedCode =
      exchange.response.body.type === 'error' ? exchange.response.body.error.code : undefined;
    const sent: SentRequest = {
      requestId,
      kind: 'workflow.signal.reconcile',
      eventId: payload.signal.eventId,
    };
    const mismatch = checkCorrelation(sent, exchange.response);
    if (mismatch !== undefined) {
      const outcome: ReconcileUnknown = {
        kind: 'unknown',
        reason: 'correlation_mismatch',
        detail: `${mismatch.field}: expected ${mismatch.expected}, got ${String(mismatch.actual)}`,
        ...(reportedCode === undefined ? {} : { reportedCode }),
      };
      return finish(outcome);
    }

    const wrongAxis = versionAxisMismatch(exchange.response, 'accepted-operation');
    if (wrongAxis !== undefined) return finish(wrongAxis);

    const { body } = exchange.response;
    switch (body.type) {
      case 'workflow.signal.reconciliation':
        return finish({
          kind: classifyCorrelatedOutcome('workflow.signal.reconcile', {
            kind: 'success',
            disposition: body.result.disposition,
          }) as 'accepted' | 'conflict' | 'absent',
          eventId: body.result.eventId,
        });
      case 'error': {
        const outcome = classifyCorrelatedOutcome(
          'workflow.signal.reconcile',
          { kind: 'error' },
          body.error.code,
        );
        return finish({
          kind: outcome === 'unknown' ? outcome : 'unknown',
          reason: 'reported_unknown',
          reportedCode: body.error.code,
          detail: `${body.error.code}: ${body.error.message}`,
        });
      }
      default:
        return finish({
          kind: 'unknown',
          reason: 'undecodable_response',
          detail: 'reconcile answered with a non-reconciliation body',
        });
    }
  }

  #finish<T extends { readonly kind: TimingOutcome }>(
    operation_kind: ParentOperationKind,
    timing: TransportTiming,
    outcome: T,
    reportedErrorCode?: string,
  ): T {
    const classified = outcome as {
      readonly kind: TimingOutcome;
      readonly code?: string;
      readonly reason?: UnknownOutcome['reason'];
      readonly reportedCode?: string;
    };
    const reportedError = reportedErrorCode ?? classified.code ?? classified.reportedCode;
    const errorCode =
      reportedError !== undefined && isTimingErrorCode(reportedError) ? reportedError : undefined;
    const measurement: ParentTimingMeasurement = {
      operation_kind,
      ...timing,
      outcome: parentTimingOutcome(operation_kind, classified.kind, errorCode),
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
      ...(classified.reason === undefined ? {} : { unknown_reason: classified.reason }),
    };
    emitBestEffort(this.#config.timingSink, measurement);
    return outcome;
  }

  #exchange(
    frame: string,
    requestAxis: Response['version']['axis'],
    signal: AbortSignal | undefined,
  ): Promise<Exchange> {
    const { command, env = {}, stateDir, timeoutMs } = this.#config;
    return new Promise((resolve) => {
      const started = performance.now();
      let spawnToExitMs: number | undefined;
      let responseFirstByteMs: number | undefined;
      const timing = (): TransportTiming => ({
        ...(spawnToExitMs === undefined ? {} : { spawn_to_exit_ms: spawnToExitMs }),
        ...(responseFirstByteMs === undefined
          ? {}
          : { response_first_byte_ms: responseFirstByteMs }),
      });
      if (signal?.aborted) {
        resolve(unknown('aborted', 'cancelled before the process was spawned', timing()));
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let child: ReturnType<typeof spawn> | undefined;
      const onAbort = () => {
        child?.kill('SIGKILL');
        settle(unknown('aborted', 'cancelled while waiting; the core may have appended', timing()));
      };
      const settle = (exchange: Exchange) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(exchange);
      };

      try {
        child = spawn(command, ['handle', '--state', stateDir], {
          // Only PATH and the configured variables: the core never needs the
          // harness process environment, and credentials must not leak in.
          env: { PATH: process.env.PATH ?? '', ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        settle(unknown('spawn_failed', String(error), timing()));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const spawned = child;
      const stdout = new OneShotFrameCollector(MAX_FRAME_BYTES);
      spawned.stdout?.on('data', (chunk: Buffer) => {
        responseFirstByteMs ??= performance.now() - started;
        if (!stdout.append(chunk)) {
          spawned.kill('SIGKILL');
          settle(
            unknown(
              'oversized_response',
              `stdout exceeded ${MAX_FRAME_BYTES} bytes; the core may have appended`,
              timing(),
            ),
          );
          return;
        }
      });
      spawned.stderr?.on('data', () => undefined);
      spawned.on('error', (error) => settle(unknown('spawn_failed', error.message, timing())));

      spawned.once('exit', () => {
        spawnToExitMs ??= performance.now() - started;
      });

      timer = setTimeout(() => {
        spawned.kill('SIGKILL');
        settle(
          unknown(
            'timeout',
            `no response within ${timeoutMs}ms; the core may have appended`,
            timing(),
          ),
        );
      }, timeoutMs);

      spawned.on('close', (code, closeSignal) => {
        spawnToExitMs ??= performance.now() - started;
        const extraction = stdout.extract();
        if (extraction.kind === 'oversized') {
          settle(unknown('oversized_response', extraction.detail, timing()));
          return;
        }
        if (extraction.kind === 'empty') {
          settle(
            unknown('no_response', `process exited with ${String(code)} without a frame`, timing()),
          );
          return;
        }
        if (extraction.kind === 'extra') {
          settle(unknown('undecodable_response', extraction.detail, timing()));
          return;
        }
        if (closeSignal !== null || code === null) {
          settle(
            unknown(
              'no_response',
              `process terminated without an exit code (${String(closeSignal)})`,
              timing(),
            ),
          );
          return;
        }
        if (code !== 0) {
          settle(
            unknown(
              'undecodable_response',
              `process exited ${code} while emitting a response frame`,
              timing(),
            ),
          );
          return;
        }
        try {
          settle({
            kind: 'response',
            response: decodeResponse(extraction.frame, requestAxis),
            timing: timing(),
          });
        } catch (error) {
          settle(unknown('undecodable_response', String(error), timing()));
        }
      });

      spawned.stdin?.on('error', () => undefined);
      spawned.stdin?.end(`${frame}\n`);
    });
  }
}
