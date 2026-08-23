/**
 * A fake `aizu` binary for adapter tests. Speaks Protocol v1 over the same
 * one-shot stdin/stdout contract, keeps a tiny JSON state so duplicates and
 * conflicts behave, and injects faults on request.
 *
 * Run as `node fake-core.js hello` or `node fake-core.js handle --state <dir>`.
 *
 * Faults (`AIZU_FAKE_FAULT`):
 * - `no-response`       exit 0 without writing a frame
 * - `garbage`           write a non-protocol line
 * - `hang`              never answer (the client's timeout must fire)
 * - `journal-unknown`   record the signal, then report JOURNAL_OUTCOME_UNKNOWN
 * - `exit-2`            usage-style failure without a frame
 *
 * `AIZU_FAKE_HELLO_PROTOCOL_VERSION` overrides the advertised protocol
 * version, for compatibility-check tests.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  codes,
  DecodeFailure,
  decodeRequest,
  encodeResponse,
  type HelloInfo,
  KIND_HELLO,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  type Request,
  type Response,
  type WorkflowSignal,
} from '@aizu/protocol';

const STATE_FILE = 'fake-journal.json';
const REQUEST_LOG = 'fake-requests.jsonl';

const helloInfo: HelloInfo = {
  protocolVersion: Number(process.env.AIZU_FAKE_HELLO_PROTOCOL_VERSION ?? PROTOCOL_VERSION),
  journalSchemaVersion: 1,
  capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
  package: { name: 'aizu-fake', version: '0.0.0' },
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
  if (signal.role !== expected.role) return reject('ROLE_MISMATCH', 'role mismatch');
  if (signal.artifactRevision !== expected.artifactRevision) {
    return reject('REVISION_MISMATCH', 'revision mismatch');
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
  if (process.env.AIZU_FAKE_FAULT === 'journal-unknown') {
    return reject('JOURNAL_OUTCOME_UNKNOWN', 'append outcome unknown: acknowledgement lost');
  }
  return {
    requestId: request.requestId,
    kind: request.kind,
    body: { type: 'workflow.signal', result: { disposition: 'accepted', eventId: signal.eventId } },
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const fault = process.env.AIZU_FAKE_FAULT;
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
  write(handleSubmit(stateDir, request));
  return 0;
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
