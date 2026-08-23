/**
 * This adapter's `CoreClient`: spawn `aizu`, write one frame, read one
 * frame, classify everything else as unknown. No retries anywhere.
 */

import { spawn } from 'node:child_process';
import {
  type CallOptions,
  type CoreClient,
  type CoreClientConfig,
  decodeResponse,
  encodeRequest,
  type HelloOutcome,
  isUnknownOutcomeCode,
  type Response,
  type SubmitOutcome,
  type UnknownOutcome,
  type WorkflowSignalSubmitPayload,
} from '@aizu/protocol';

type Exchange =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'unknown'; readonly outcome: UnknownOutcome };

function unknown(reason: UnknownOutcome['reason'], detail: string): Exchange {
  return { kind: 'unknown', outcome: { kind: 'unknown', reason, detail } };
}

function reportedUnknown(code: string, message: string): UnknownOutcome {
  return { kind: 'unknown', reason: 'reported_unknown', detail: `${code}: ${message}` };
}

export class OneShotCoreClient implements CoreClient {
  readonly #config: CoreClientConfig;

  constructor(config: CoreClientConfig) {
    this.#config = config;
  }

  async hello(_requestId: string, options: CallOptions = {}): Promise<HelloOutcome> {
    const exchange = await this.#exchange(['hello'], undefined, options.signal);
    if (exchange.kind === 'unknown') return exchange.outcome;
    const { body } = exchange.response;
    switch (body.type) {
      case 'hello':
        return { kind: 'ok', info: body.info };
      case 'error':
        return isUnknownOutcomeCode(body.error.code)
          ? reportedUnknown(body.error.code, body.error.message)
          : { kind: 'error', code: body.error.code, message: body.error.message };
      default:
        return {
          kind: 'unknown',
          reason: 'undecodable_response',
          detail: 'hello answered with a non-hello body',
        };
    }
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
    const { body } = exchange.response;
    switch (body.type) {
      case 'workflow.signal':
        return { kind: body.result.disposition, eventId: body.result.eventId };
      case 'error':
        return isUnknownOutcomeCode(body.error.code)
          ? reportedUnknown(body.error.code, body.error.message)
          : { kind: 'rejected', code: body.error.code, message: body.error.message };
      default:
        return {
          kind: 'unknown',
          reason: 'undecodable_response',
          detail: 'submit answered with a non-signal body',
        };
    }
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
      let child: ReturnType<typeof spawn> | undefined;
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

      try {
        child = spawn(command, [...args, ...subcommand], {
          // Only PATH and the configured variables: the core never needs the
          // harness process environment, and credentials must not leak in.
          env: { PATH: process.env.PATH ?? '', ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        settle(unknown('spawn_failed', String(error)));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const spawned = child;
      const stdout: Buffer[] = [];
      spawned.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      spawned.stderr?.on('data', () => undefined);
      spawned.on('error', (error) => settle(unknown('spawn_failed', error.message)));

      timer = setTimeout(() => {
        spawned.kill('SIGKILL');
        settle(unknown('timeout', `no response within ${timeoutMs}ms; the core may have appended`));
      }, timeoutMs);

      spawned.on('close', (code) => {
        const line = Buffer.concat(stdout).toString('utf8').split('\n', 1)[0] ?? '';
        if (line.length === 0) {
          settle(unknown('no_response', `process exited with ${String(code)} without a frame`));
          return;
        }
        try {
          settle({ kind: 'response', response: decodeResponse(line) });
        } catch (error) {
          settle(unknown('undecodable_response', String(error)));
        }
      });

      spawned.stdin?.on('error', () => undefined);
      spawned.stdin?.end(frame === undefined ? undefined : `${frame}\n`);
    });
  }
}
