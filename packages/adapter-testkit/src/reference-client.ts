/**
 * A reference `CoreClient`: spawn the binary, write one frame, read one
 * frame, and classify everything else as an unknown outcome. Adapters own
 * their core client; this one exists to validate the conformance runner
 * and as a starting point.
 */

import { spawn } from 'node:child_process';
import {
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

export class ReferenceOneShotClient implements CoreClient {
  readonly #config: CoreClientConfig;

  constructor(config: CoreClientConfig) {
    this.#config = config;
  }

  async hello(requestId: string): Promise<HelloOutcome> {
    const exchange = await this.#exchange(['hello'], undefined);
    if (exchange.kind === 'unknown') return exchange.outcome;
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
  ): Promise<SubmitOutcome> {
    const frame = encodeRequest({ requestId, kind: 'workflow.signal.submit', payload });
    const exchange = await this.#exchange(['handle', '--state', this.#config.stateDir], frame);
    if (exchange.kind === 'unknown') return exchange.outcome;
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

  #exchange(subcommand: readonly string[], frame: string | undefined): Promise<Exchange> {
    const { command, args = [], env = {}, timeoutMs } = this.#config;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (exchange: Exchange) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(exchange);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, [...args, ...subcommand], {
          env: { PATH: process.env.PATH ?? '', ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        settle(unknown('spawn_failed', String(error)));
        return;
      }
      const stdout: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', () => undefined);
      child.on('error', (error) => settle(unknown('spawn_failed', error.message)));

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(unknown('timeout', `no response within ${timeoutMs}ms; the core may have appended`));
      }, timeoutMs);

      child.on('close', (code) => {
        const output = Buffer.concat(stdout).toString('utf8');
        const line = output.split('\n', 1)[0] ?? '';
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

      if (frame !== undefined) {
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(`${frame}\n`);
      } else {
        child.stdin?.end();
      }
    });
  }
}
