/**
 * A reference `CoreClient`: spawn the binary, write one frame, read one
 * frame, and classify everything else as an unknown outcome. Adapters own
 * their core client; this one exists to validate the conformance runner
 * and as a starting point.
 */

import { spawn } from 'node:child_process';
import {
  type CallOptions,
  type CoreClient,
  type CoreClientConfig,
  checkCorrelation,
  decodeResponse,
  emitBestEffort,
  encodeRequest,
  extractFrame,
  type HelloOutcome,
  isSubmitRejectionCode,
  isTimingErrorCode,
  isUnknownOutcomeCode,
  MAX_FRAME_BYTES,
  type ParentOperationKind,
  type ParentTimingMeasurement,
  parentTimingOutcome,
  type ReconcileOutcome,
  type ReconcileUnknown,
  type Response,
  type SentRequest,
  type SubmitOutcome,
  type TimingOutcome,
  type UnknownOutcome,
  type WorkflowSignalReconcilePayload,
  type WorkflowSignalSubmitPayload,
} from '@aizign/protocol';

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

export class ReferenceOneShotClient implements CoreClient {
  readonly #config: CoreClientConfig;

  constructor(config: CoreClientConfig) {
    this.#config = config;
  }

  async hello(requestId: string, options: CallOptions = {}): Promise<HelloOutcome> {
    const exchange = await this.#exchange(['hello'], undefined, options.signal);
    const finish = (outcome: HelloOutcome, reportedErrorCode?: string) =>
      this.#finish('hello', exchange.timing, outcome, reportedErrorCode);
    if (exchange.kind === 'unknown') return finish(exchange.outcome);
    // `aizign hello` has no request frame, so only the kind can be correlated.
    if (exchange.response.kind !== 'hello') {
      return finish({
        kind: 'unknown',
        reason: 'correlation_mismatch',
        detail: `kind: expected hello, got ${String(exchange.response.kind)} (${requestId})`,
      });
    }
    const { body } = exchange.response;
    if (body.type === 'hello') return finish({ kind: 'ok', info: body.info });
    if (body.type === 'error') {
      if (isUnknownOutcomeCode(body.error.code)) {
        return finish(
          {
            kind: 'unknown',
            reason: 'reported_unknown',
            reportedCode: body.error.code,
            detail: `${body.error.code}: ${body.error.message}`,
          },
          body.error.code,
        );
      }
      return finish(
        { kind: 'error', code: body.error.code, message: body.error.message },
        body.error.code,
      );
    }
    return finish({
      kind: 'unknown',
      reason: 'undecodable_response',
      detail: `unexpected body for ${requestId}`,
    });
  }

  async submitWorkflowSignal(
    requestId: string,
    payload: WorkflowSignalSubmitPayload,
    options: CallOptions = {},
  ): Promise<SubmitOutcome> {
    const frame = encodeRequest({ requestId, kind: 'workflow.signal.submit', payload });
    const exchange = await this.#exchange(
      ['handle', '--state', this.#config.stateDir],
      frame,
      options.signal,
    );
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
    const { body } = exchange.response;
    if (body.type === 'workflow.signal') {
      return finish({ kind: body.result.disposition, eventId: body.result.eventId });
    }
    if (body.type === 'error') {
      if (!isSubmitRejectionCode(body.error.code)) {
        return finish(
          {
            kind: 'unknown',
            reason: 'reported_unknown',
            reportedCode: body.error.code,
            detail: `${body.error.code}: ${body.error.message}`,
          },
          body.error.code,
        );
      }
      return finish(
        { kind: 'rejected', code: body.error.code, message: body.error.message },
        body.error.code,
      );
    }
    return finish({
      kind: 'unknown',
      reason: 'undecodable_response',
      detail: 'response body does not match the request',
    });
  }

  async reconcileWorkflowSignal(
    requestId: string,
    payload: WorkflowSignalReconcilePayload,
    options: CallOptions = {},
  ): Promise<ReconcileOutcome> {
    const frame = encodeRequest({ requestId, kind: 'workflow.signal.reconcile', payload });
    const exchange = await this.#exchange(
      ['handle', '--state', this.#config.stateDir],
      frame,
      options.signal,
    );
    const finish = (outcome: ReconcileOutcome) =>
      this.#finish('workflow.signal.reconcile', exchange.timing, outcome);
    if (exchange.kind === 'unknown') return finish(exchange.outcome);
    const reportedCode =
      exchange.response.body.type === 'error' ? exchange.response.body.error.code : undefined;
    const mismatch = checkCorrelation(
      { requestId, kind: 'workflow.signal.reconcile', eventId: payload.signal.eventId },
      exchange.response,
    );
    if (mismatch !== undefined) {
      const outcome: ReconcileUnknown = {
        kind: 'unknown',
        reason: 'correlation_mismatch',
        detail: `${mismatch.field}: expected ${mismatch.expected}, got ${String(mismatch.actual)}`,
        ...(reportedCode === undefined ? {} : { reportedCode }),
      };
      return finish(outcome);
    }
    const { body } = exchange.response;
    if (body.type === 'workflow.signal.reconciliation') {
      return finish({ kind: body.result.disposition, eventId: body.result.eventId });
    }
    if (body.type === 'error') {
      return finish({
        kind: 'unknown',
        reason: 'reported_unknown',
        reportedCode: body.error.code,
        detail: `${body.error.code}: ${body.error.message}`,
      });
    }
    return finish({
      kind: 'unknown',
      reason: 'undecodable_response',
      detail: 'response body does not match the reconciliation request',
    });
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
    subcommand: readonly string[],
    frame: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Exchange> {
    const { command, args = [], env = {}, timeoutMs } = this.#config;
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

      let child: ReturnType<typeof spawn> | undefined;
      try {
        child = spawn(command, [...args, ...subcommand], {
          env: { PATH: process.env.PATH ?? '', ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        settle(unknown('spawn_failed', String(error), timing()));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const stdout: Buffer[] = [];
      const spawned = child;
      let received = 0;
      spawned.stdout?.on('data', (chunk: Buffer) => {
        responseFirstByteMs ??= performance.now() - started;
        received += chunk.length;
        if (received > MAX_FRAME_BYTES + 1) {
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
        stdout.push(chunk);
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

      spawned.on('close', (code) => {
        const extraction = extractFrame(Buffer.concat(stdout));
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
        try {
          settle({
            kind: 'response',
            response: decodeResponse(extraction.frame),
            timing: timing(),
          });
        } catch (error) {
          settle(unknown('undecodable_response', String(error), timing()));
        }
      });

      spawned.stdin?.on('error', () => undefined);
      spawned.stdin?.end(frame === undefined ? undefined : `${frame}\n`);
    });
  }
}
