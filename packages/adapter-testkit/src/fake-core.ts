/**
 * A fake `aizign` binary for adapter tests. Speaks Protocol v1 over the same
 * one-shot stdin/stdout contract, keeps a tiny JSON state so duplicates and
 * conflicts behave, and injects faults on request.
 *
 * Run as `node fake-core.js hello` or `node fake-core.js handle --state <dir>`.
 *
 * Faults (`AIZIGN_FAKE_FAULT`):
 * - `no-response`       exit 0 without writing a frame
 * - `garbage`           write a non-protocol line
 * - `hang`              never answer (the client's timeout must fire)
 * - `journal-unknown`   record the signal, then report JOURNAL_OUTCOME_UNKNOWN
 * - `exit-2`            usage-style failure without a frame
 * - `wrong-request-id`  answer with another request id
 * - `wrong-kind`        answer a signal request with a hello body
 * - `wrong-event-id`    answer a signal request with another event id
 * - `oversized`         answer with a frame above the bound
 * - `two-frames`        answer twice
 * - `trailing-garbage`  answer, then keep talking
 * - `handler-timeout`   report HANDLER_TIMEOUT without correlation ids
 * - `event-conflict-error` report EVENT_CONFLICT as a correlated error
 *
 * `AIZIGN_FAKE_HELLO_PROTOCOL_VERSION` overrides the advertised protocol
 * version, for compatibility-check tests.
 * `AIZIGN_FAKE_CAPABILITIES` is a comma-separated capability override.
 * `AIZIGN_FAKE_INVOCATION_LOG` records that this process started, allowing a
 * caller to prove that local validation failed before spawn.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  codes,
  DecodeFailure,
  decodeRequest,
  encodeResponse,
  type HelloInfo,
  KIND_HELLO,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BYTES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  ProtocolError,
  type Request,
  type Response,
  type WorkflowSignal,
} from '@aizign/protocol';

const STATE_FILE = 'fake-journal.json';
const REQUEST_LOG = 'fake-requests.jsonl';

const invocationLog = process.env.AIZIGN_FAKE_INVOCATION_LOG;
if (invocationLog !== undefined) {
  writeFileSync(invocationLog, 'started\n', { flag: 'a', mode: 0o600 });
}

const helloInfo: HelloInfo = {
  protocolVersion: Number(process.env.AIZIGN_FAKE_HELLO_PROTOCOL_VERSION ?? PROTOCOL_VERSION),
  journalSchemaVersion: 1,
  capabilities: process.env.AIZIGN_FAKE_CAPABILITIES?.split(',').filter(Boolean) ?? [
    CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
    CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  ],
  package: { name: 'aizign-fake', version: '0.0.0' },
};

function write(response: Response): void {
  process.stdout.write(`${encodeResponse(response)}\n`);
}

function errorResponse(
  requestId: string | null,
  kind: string | null,
  code: string,
  message: string,
): Response {
  return { requestId, kind, body: { type: 'error', error: new ProtocolError(code, message) } };
}

async function readFrame(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    chunks.push(buffer);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES + 1) break;
  }
  let frame = Buffer.concat(chunks);
  const newline = frame.indexOf(0x0a);
  if (newline >= 0) frame = frame.subarray(0, newline);
  return new Uint8Array(frame);
}

function loadState(stateDir: string): WorkflowSignal[] {
  const path = join(stateDir, STATE_FILE);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as WorkflowSignal[];
}

function saveState(stateDir: string, accepted: WorkflowSignal[]): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, STATE_FILE), JSON.stringify(accepted), { mode: 0o600 });
}

function sameSignal(a: WorkflowSignal, b: WorkflowSignal): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function handleSubmit(
  stateDir: string,
  request: Extract<Request, { kind: 'workflow.signal.submit' }>,
): Response {
  const { expected, signal } = request.payload;
  const reject = (code: string, message: string) =>
    errorResponse(request.requestId, request.kind, code, message);
  if (signal.workflowId !== expected.workflowId)
    return reject('WORKFLOW_MISMATCH', 'workflow mismatch');
  if (signal.assignmentId !== expected.assignmentId)
    return reject('ASSIGNMENT_MISMATCH', 'assignment mismatch');
  if (signal.attemptId !== expected.attemptId)
    return reject('ATTEMPT_MISMATCH', 'attempt mismatch');
  if (signal.role !== expected.role) return reject('ROLE_MISMATCH', 'role mismatch');
  if (signal.artifactRevision !== expected.artifactRevision) {
    return reject('REVISION_MISMATCH', 'revision mismatch');
  }
  if (JSON.stringify(signal.candidateDigest) !== JSON.stringify(expected.candidateDigest)) {
    return reject('CANDIDATE_DIGEST_MISMATCH', 'candidate digest mismatch');
  }
  const accepted = loadState(stateDir);
  const existing = accepted.find((candidate) => candidate.eventId === signal.eventId);
  if (existing !== undefined) {
    if (sameSignal(existing, signal)) {
      return {
        requestId: request.requestId,
        kind: request.kind,
        body: {
          type: 'workflow.signal',
          result: { disposition: 'duplicate', eventId: signal.eventId },
        },
      };
    }
    return reject(
      'EVENT_CONFLICT',
      `event ${signal.eventId} was already accepted with different content`,
    );
  }
  accepted.push(signal);
  saveState(stateDir, accepted);
  if (process.env.AIZIGN_FAKE_FAULT === 'journal-unknown') {
    return reject('JOURNAL_OUTCOME_UNKNOWN', 'append outcome unknown: acknowledgement lost');
  }
  return {
    requestId: request.requestId,
    kind: request.kind,
    body: { type: 'workflow.signal', result: { disposition: 'accepted', eventId: signal.eventId } },
  };
}

function handleReconcile(
  stateDir: string,
  request: Extract<Request, { kind: 'workflow.signal.reconcile' }>,
): Response {
  const { signal } = request.payload;
  const existing = loadState(stateDir).find((candidate) => candidate.eventId === signal.eventId);
  const disposition =
    existing === undefined ? 'absent' : sameSignal(existing, signal) ? 'accepted' : 'conflict';
  return {
    requestId: request.requestId,
    kind: request.kind,
    body: {
      type: 'workflow.signal.reconciliation',
      result: { disposition, eventId: signal.eventId },
    },
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const fault = process.env.AIZIGN_FAKE_FAULT;
  if (fault === 'exit-2') return 2;
  if (fault === 'hang') {
    // Keep the event loop alive; an idle Node process would otherwise exit.
    setInterval(() => undefined, 60_000);
    await new Promise(() => undefined);
    return 0;
  }
  if (fault === 'no-response') return 0;
  if (fault === 'garbage') {
    process.stdout.write('this is not a protocol frame\n');
    return 0;
  }

  if (argv[0] === 'hello' && argv.length === 1) {
    write({ requestId: null, kind: KIND_HELLO, body: { type: 'hello', info: helloInfo } });
    return 0;
  }
  if (argv[0] !== 'handle' || argv[1] !== '--state' || !argv[2]) {
    process.stderr.write('usage: fake-core hello | fake-core handle --state <dir>\n');
    return 2;
  }
  const stateDir = argv[2];
  const frame = await readFrame();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, REQUEST_LOG), `${new TextDecoder().decode(frame)}\n`, { flag: 'a' });

  let request: Request;
  try {
    request = decodeRequest(frame);
  } catch (error) {
    if (error instanceof DecodeFailure) {
      write(errorResponse(error.requestId, error.kind, error.error.code, error.error.message));
      return 0;
    }
    write(errorResponse(null, null, codes.INTERNAL, 'fake core failed to decode'));
    return 0;
  }
  if (request.kind === 'hello') {
    write({
      requestId: request.requestId,
      kind: request.kind,
      body: { type: 'hello', info: helloInfo },
    });
    return 0;
  }
  const response =
    request.kind === 'workflow.signal.submit'
      ? handleSubmit(stateDir, request)
      : handleReconcile(stateDir, request);
  switch (fault) {
    case 'handler-timeout':
      write(errorResponse(null, null, codes.HANDLER_TIMEOUT, 'processing exceeded its bound'));
      return 0;
    case 'event-conflict-error':
      write(errorResponse(request.requestId, request.kind, 'EVENT_CONFLICT', 'reported conflict'));
      return 0;
    case 'wrong-request-id':
      write({ ...response, requestId: 'req-someone-else' });
      return 0;
    case 'wrong-kind':
      write({
        requestId: request.requestId,
        kind: 'hello',
        body: { type: 'hello', info: helloInfo },
      });
      return 0;
    case 'wrong-event-id':
      write({
        requestId: request.requestId,
        kind: request.kind,
        body:
          request.kind === 'workflow.signal.submit'
            ? {
                type: 'workflow.signal',
                result: { disposition: 'accepted', eventId: 'evt-someone-else' },
              }
            : {
                type: 'workflow.signal.reconciliation',
                result: { disposition: 'accepted', eventId: 'evt-someone-else' },
              },
      });
      return 0;
    case 'oversized':
      // Deliberately bypass the production encoder: this fault is an invalid
      // peer frame, while encodeResponse must fail closed above the bound.
      process.stdout.write(
        `${JSON.stringify({
          protocol: PROTOCOL_NAME,
          version: PROTOCOL_VERSION,
          requestId: request.requestId,
          kind: request.kind,
          ok: false,
          error: { code: codes.INTERNAL, message: 'x'.repeat(MAX_FRAME_BYTES + 1) },
        })}\n`,
      );
      return 0;
    case 'two-frames':
      write(response);
      write(response);
      return 0;
    case 'trailing-garbage':
      write(response);
      process.stdout.write('and then some prose\n');
      return 0;
    default:
      write(response);
      return 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`fake-core: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
