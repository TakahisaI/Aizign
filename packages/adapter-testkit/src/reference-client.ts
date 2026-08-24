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
  encodeRequest,
  extractFrame,
  type HelloOutcome,
  isUnknownOutcomeCode,
  MAX_FRAME_BYTES,
  type ReconcileOutcome,
  type ReconcileUnknown,
  type Response,
  type SentRequest,
  type SubmitOutcome,
  type UnknownOutcome,
  type WorkflowSignalReconcilePayload,
  type WorkflowSignalSubmitPayload,
} from '@aizign/protocol';

type Exchange =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'unknown'; readonly outcome: UnknownOutcome };

function unknown(reason: UnknownOutcome['reason'], detail: string): Exchange {
  return { kind: 'unknown', outcome: { kind: 'unknown', reason, detail } };
}

export class ReferenceOneShotClient implements CoreClient {
  readonly #config: CoreClientConfig;

  constructor(config: CoreClientConfig) {
    this.#config = config;
  }

  async hello(requestId: string, options: CallOptions = {}): Promise<HelloOutcome> {
    const exchange = await this.#exchange(['hello'], undefined, options.signal);
    if (exchange.kind === 'unknown') return exchange.outcome;
    // `aizign hello` has no request frame, so only the kind can be correlated.
    if (exchange.response.kind !== 'hello') {
      return {
        kind: 'unknown',
        reason: 'correlation_mismatch',
        detail: `kind: expected hello, got ${String(exchange.response.kind)} (${requestId})`,
      };
    }
    const { body } = exchange.response;
    if (body.type === 'hello') return { kind: 'ok', info: body.info };
    if (body.type === 'error') {
      if (isUnknownOutcomeCode(body.error.code)) {
        return {
          kind: 'unknown',
          reason: 'reported_unknown',
          detail: `${body.error.code}: ${body.error.message}`,
        };
      }
      return { kind: 'error', code: body.error.code, message: body.error.message };
    }
    return {
      kind: 'unknown',
      reason: 'undecodable_response',
      detail: `unexpected body for ${requestId}`,
    };
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
    if (exchange.kind === 'unknown') return exchange.outcome;
    const sent: SentRequest = {
      requestId,
      kind: 'workflow.signal.submit',
      eventId: payload.signal.eventId,
    };
    const mismatch = checkCorrelation(sent, exchange.response);
    if (mismatch !== undefined) {
      return {
        kind: 'unknown',
        reason: 'correlation_mismatch',
        detail: `${mismatch.field}: expected ${mismatch.expected}, got ${String(mismatch.actual)}`,
      };
    }
    const { body } = exchange.response;
    if (body.type === 'workflow.signal') {
      return { kind: body.result.disposition, eventId: body.result.eventId };
    }
    if (body.type === 'error') {
      if (isUnknownOutcomeCode(body.error.code)) {
        return {
          kind: 'unknown',
          reason: 'reported_unknown',
          detail: `${body.error.code}: ${body.error.message}`,
        };
      }
      return { kind: 'rejected', code: body.error.code, message: body.error.message };
    }
    return {
      kind: 'unknown',
      reason: 'undecodable_response',
      detail: 'response body does not match the request',
    };
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
    if (exchange.kind === 'unknown') return exchange.outcome;
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
      return outcome;
    }
    const { body } = exchange.response;
    if (body.type === 'workflow.signal.reconciliation') {
      return { kind: body.result.disposition, eventId: body.result.eventId };
    }
    if (body.type === 'error') {
      return {
        kind: 'unknown',
        reason: 'reported_unknown',
        reportedCode: body.error.code,
        detail: `${body.error.code}: ${body.error.message}`,
      };
    }
    return {
      kind: 'unknown',
      reason: 'undecodable_response',
      detail: 'response body does not match the reconciliation request',
    };
  }

  #exchange(
    subcommand: readonly string[],
    frame: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Exchange> {
    const { command, args = [], env = {}, timeoutMs } = this.#config;
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(unknown('aborted', 'cancelled before the process was spawned'));
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        child?.kill('SIGKILL');
        settle(unknown('aborted', 'cancelled while waiting; the core may have appended'));
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
        settle(unknown('spawn_failed', String(error)));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const stdout: Buffer[] = [];
      const spawned = child;
      let received = 0;
      spawned.stdout?.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_FRAME_BYTES + 1) {
          spawned.kill('SIGKILL');
          settle(
            unknown(
              'oversized_response',
              `stdout exceeded ${MAX_FRAME_BYTES} bytes; the core may have appended`,
            ),
          );
          return;
        }
        stdout.push(chunk);
      });
      spawned.stderr?.on('data', () => undefined);
      spawned.on('error', (error) => settle(unknown('spawn_failed', error.message)));

      timer = setTimeout(() => {
        spawned.kill('SIGKILL');
        settle(unknown('timeout', `no response within ${timeoutMs}ms; the core may have appended`));
      }, timeoutMs);

      spawned.on('close', (code) => {
        const extraction = extractFrame(Buffer.concat(stdout).toString('utf8'));
        if (extraction.kind === 'empty') {
          settle(unknown('no_response', `process exited with ${String(code)} without a frame`));
          return;
        }
        if (extraction.kind === 'extra') {
          settle(unknown('undecodable_response', extraction.detail));
          return;
        }
        try {
          settle({ kind: 'response', response: decodeResponse(extraction.frame) });
        } catch (error) {
          settle(unknown('undecodable_response', String(error)));
        }
      });

      spawned.stdin?.on('error', () => undefined);
      spawned.stdin?.end(frame === undefined ? undefined : `${frame}\n`);
    });
  }
}
