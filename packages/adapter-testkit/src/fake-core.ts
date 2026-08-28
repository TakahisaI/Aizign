/**
 * A fake `aizign` binary for adapter tests. Speaks Protocol v1 over the same
 * one-shot stdin/stdout contract, keeps a tiny JSON state so duplicates and
 * conflicts behave, and injects faults on request.
 *
 * A repository-test wrapper invokes it as `handle --state <dir>` for every
 * operation, including hello.
 *
 * Faults (`AIZIGN_FAKE_FAULT`):
 * - `no-response`       exit 0 without writing a frame
 * - `garbage`           write a non-protocol line
 * - `hang`              never answer (the client's timeout must fire)
 * - `journal-unknown`   record the signal, then report JOURNAL_OUTCOME_UNKNOWN
 * - `exit-2`            usage-style failure without a frame
 * - `wrong-request-id`  answer with another request id
 * - `wrong-kind`        answer a signal request with a hello body
 * - `null-correlation`  answer with null request id and kind
 * - `wrong-event-id`    answer a signal request with another event id
 * - `oversized`         answer with a frame above the bound
 * - `two-frames`        answer twice
 * - `trailing-garbage`  answer, then keep talking
 * - `handler-timeout`   report HANDLER_TIMEOUT without correlation ids
 * - `event-conflict-error` report EVENT_CONFLICT as a correlated error
 * - `unknown-valid-error-code` report an unrecognized, well-formed correlated error code
 * - `unknown-valid-error-code-wrong-request-id` report that code without request correlation
 * - `invalid-utf8`      write a correlated rejection frame containing a raw invalid byte
 * - `no-lf-response`    write a valid body without LF
 * - `bom-response`      prefix a valid response body with a UTF-8 BOM
 * - `exact-max`         write one valid exact-bound response body plus LF
 * - `post-lf-space`     write a valid frame followed by a space
 * - `post-lf-tab`       write a valid frame followed by a tab
 * - `post-lf-cr`        write a valid frame followed by CR
 * - `post-lf-lf`        write a valid frame followed by another LF
 * - `crlf-response`     terminate the response with CRLF
 * - `nonzero-with-frame` write a valid frame and exit nonzero
 * - `no-close-after-frame` write a valid frame and keep the process open
 * - `process-open-after-stdout-close` close stdout after a frame and keep the process open
 * - `signal-terminated` terminate by signal without a frame
 * - `operation-version-unsupported` return a correlated bootstrap compatibility error
 * - `wrong-operation-version` return a response on the wrong numeric operation version
 * - `invalid-response-source` prove encoder rejection writes zero stdout bytes
 *
 * `AIZIGN_FAKE_HELLO_PROTOCOL_VERSION` overrides the advertised protocol
 * version, for compatibility-check tests.
 * `AIZIGN_FAKE_CAPABILITIES` is a comma-separated capability override.
 * `AIZIGN_FAKE_INVOCATION_LOG` records that this process started, allowing a
 * caller to prove that local validation failed before spawn.
 * `AIZIGN_FAKE_ARGV_LOG` records the exact argv received by the fake binary.
 * These variables are injected only by repository-test executable wrappers;
 * production client configuration has no environment-control surface.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOTSTRAP_ENVELOPE_VERSION,
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  codes,
  DecodeFailure,
  decodeRequest,
  encodeResponse,
  type HelloInfo,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BYTES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  ProtocolError,
  type Request,
  type Response,
  type ResponseVersion,
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
  writeFrame(encodeResponse(response));
}

function writeFrame(frame: string): void {
  process.stdout.write(`${frame}\n`);
}

function boundedErrorFrame(response: Response): string {
  if (response.body.type !== 'error') return encodeResponse(response);
  try {
    return encodeResponse(response);
  } catch {
    return encodeResponse(
      errorResponse(
        response.requestId,
        null,
        response.body.error.code,
        'request rejected; recovered correlation was not safe to echo',
        response.version,
      ),
    );
  }
}

function errorResponse(
  requestId: string | null,
  kind: string | null,
  code: string,
  message: string,
  version: ResponseVersion = kind !== null &&
  kind !== 'hello' &&
  !new Set<string>([
    codes.REQUEST_TOO_LARGE,
    codes.INVALID_ENVELOPE,
    codes.PROTOCOL_VERSION_UNSUPPORTED,
    codes.HANDLER_TIMEOUT,
  ]).has(code)
    ? { axis: 'accepted-operation', version: PROTOCOL_VERSION }
    : { axis: 'bootstrap', version: BOOTSTRAP_ENVELOPE_VERSION },
): Response {
  return {
    version,
    requestId,
    kind,
    body: { type: 'error', error: new ProtocolError(code, message) },
  };
}

type ProfileRead =
  | { readonly kind: 'frame'; readonly frame: Uint8Array }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'oversized' };

async function readFrame(): Promise<ProfileRead> {
  const frame: number[] = [];
  let newlineSeen = false;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    for (const byte of buffer) {
      if (newlineSeen) return { kind: 'invalid' };
      if (byte === 0x0a) {
        if (frame.length === 0 || frame.at(-1) === 0x0d) return { kind: 'invalid' };
        newlineSeen = true;
      } else if (frame.length === MAX_REQUEST_BYTES) {
        return { kind: 'oversized' };
      } else {
        frame.push(byte);
      }
    }
  }
  return newlineSeen ? { kind: 'frame', frame: Uint8Array.from(frame) } : { kind: 'invalid' };
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
        version: { axis: 'accepted-operation', version: PROTOCOL_VERSION },
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
    version: { axis: 'accepted-operation', version: PROTOCOL_VERSION },
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
    version: { axis: 'accepted-operation', version: PROTOCOL_VERSION },
    requestId: request.requestId,
    kind: request.kind,
    body: {
      type: 'workflow.signal.reconciliation',
      result: { disposition, eventId: signal.eventId },
    },
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const argvLog = process.env.AIZIGN_FAKE_ARGV_LOG;
  if (argvLog !== undefined) {
    writeFileSync(argvLog, `${JSON.stringify(argv)}\n`, { flag: 'a', mode: 0o600 });
  }
  const fault = process.env.AIZIGN_FAKE_FAULT;
  if (fault === 'exit-2') return 2;
  if (fault === 'hang') {
    // Keep the event loop alive; an idle Node process would otherwise exit.
    setInterval(() => undefined, 60_000);
    await new Promise(() => undefined);
    return 0;
  }
  if (fault === 'no-response') return 0;
  if (fault === 'signal-terminated') {
    process.kill(process.pid, 'SIGTERM');
    await new Promise(() => undefined);
    return 0;
  }
  if (fault === 'garbage') {
    process.stdout.write('this is not a protocol frame\n');
    return 0;
  }

  if (argv[0] !== 'handle' || argv[1] !== '--state' || !argv[2] || argv.length !== 3) {
    process.stderr.write('usage: fake-core handle --state <dir>\n');
    return 2;
  }
  const stateDir = argv[2];
  const read = await readFrame();
  if (read.kind === 'invalid') {
    write(errorResponse(null, null, codes.INVALID_ENVELOPE, 'invalid process-profile request'));
    return 0;
  }
  if (read.kind === 'oversized') {
    write(errorResponse(null, null, codes.REQUEST_TOO_LARGE, 'request body exceeds its bound'));
    return 0;
  }
  const { frame } = read;

  let request: Request;
  try {
    request = decodeRequest(frame);
  } catch (error) {
    if (error instanceof DecodeFailure) {
      writeFrame(
        boundedErrorFrame(
          errorResponse(
            error.requestId,
            error.kind,
            error.error.code,
            error.error.message,
            error.responseVersion,
          ),
        ),
      );
      return 0;
    }
    write(errorResponse(null, null, codes.INTERNAL, 'fake core failed to decode'));
    return 0;
  }
  if (fault === 'operation-version-unsupported' && request.kind !== 'hello') {
    write(
      errorResponse(
        request.requestId,
        request.kind,
        codes.PROTOCOL_VERSION_UNSUPPORTED,
        'operation version is not supported',
        { axis: 'bootstrap', version: BOOTSTRAP_ENVELOPE_VERSION },
      ),
    );
    return 0;
  }
  if (request.kind !== 'hello') {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, REQUEST_LOG), `${new TextDecoder().decode(frame)}\n`, {
      flag: 'a',
    });
  }

  const response: Response =
    request.kind === 'hello'
      ? {
          version: { axis: 'bootstrap', version: 1 },
          requestId: request.requestId,
          kind: request.kind,
          body: { type: 'hello', info: helloInfo },
        }
      : request.kind === 'workflow.signal.submit'
        ? handleSubmit(stateDir, request)
        : handleReconcile(stateDir, request);
  if (fault === 'invalid-response-source') {
    write({
      ...response,
      body: {
        type: 'error',
        error: { code: codes.INTERNAL, message: 'structural lookalike' } as ProtocolError,
      },
    });
    return 0;
  }
  switch (fault) {
    case 'handler-timeout':
      write(errorResponse(null, null, codes.HANDLER_TIMEOUT, 'processing exceeded its bound'));
      return 0;
    case 'wrong-operation-version':
      if (request.kind === 'hello') throw new Error('wrong operation version requires operation');
      write({
        ...response,
        version: { axis: 'accepted-operation', version: PROTOCOL_VERSION + 1 },
      });
      return 0;
    case 'event-conflict-error':
      write(errorResponse(request.requestId, request.kind, 'EVENT_CONFLICT', 'reported conflict'));
      return 0;
    case 'unknown-valid-error-code':
      write(
        errorResponse(
          request.requestId,
          request.kind,
          'FUTURE_OUTCOME_UNKNOWN',
          'the write result could not be established',
        ),
      );
      return 0;
    case 'unknown-valid-error-code-wrong-request-id':
      write(
        errorResponse(
          'req-someone-else',
          request.kind,
          'FUTURE_OUTCOME_UNKNOWN',
          'the write result could not be established',
        ),
      );
      return 0;
    case 'invalid-utf8': {
      const marker = Buffer.from('INVALID_UTF8_MARKER');
      const encoded = Buffer.from(
        JSON.stringify({
          protocol: PROTOCOL_NAME,
          version: PROTOCOL_VERSION,
          requestId: request.requestId,
          kind: request.kind,
          ok: false,
          error: { code: 'INVALID_SIGNAL', message: marker.toString() },
        }),
      );
      const markerAt = encoded.indexOf(marker);
      if (markerAt < 0) throw new Error('invalid UTF-8 marker was not encoded');
      process.stdout.write(
        Buffer.concat([
          encoded.subarray(0, markerAt),
          Buffer.from([0xff]),
          encoded.subarray(markerAt + marker.length),
          Buffer.from('\n'),
        ]),
      );
      return 0;
    }
    case 'no-lf-response':
      process.stdout.write(encodeResponse(response));
      return 0;
    case 'bom-response':
      process.stdout.write(`\uFEFF${encodeResponse(response)}\n`);
      return 0;
    case 'exact-max': {
      const envelope = {
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        requestId: request.requestId,
        kind: request.kind,
        ok: false,
        error: { code: codes.INTERNAL, message: '' },
      };
      const base = Buffer.from(JSON.stringify(envelope));
      envelope.error.message = 'x'.repeat(MAX_FRAME_BYTES - base.length);
      const exact = Buffer.from(JSON.stringify(envelope));
      if (exact.length !== MAX_FRAME_BYTES) throw new Error('bad exact-max fixture');
      process.stdout.write(Buffer.concat([exact, Buffer.from('\n')]));
      return 0;
    }
    case 'post-lf-space':
      process.stdout.write(`${encodeResponse(response)}\n `);
      return 0;
    case 'post-lf-tab':
      process.stdout.write(`${encodeResponse(response)}\n\t`);
      return 0;
    case 'post-lf-cr':
      process.stdout.write(`${encodeResponse(response)}\n\r`);
      return 0;
    case 'post-lf-lf':
      process.stdout.write(`${encodeResponse(response)}\n\n`);
      return 0;
    case 'crlf-response':
      process.stdout.write(`${encodeResponse(response)}\r\n`);
      return 0;
    case 'nonzero-with-frame':
      write(response);
      return 7;
    case 'no-close-after-frame':
      write(response);
      setInterval(() => undefined, 60_000);
      await new Promise(() => undefined);
      return 0;
    case 'process-open-after-stdout-close':
      process.stdout.end(`${encodeResponse(response)}\n`);
      setInterval(() => undefined, 60_000);
      await new Promise(() => undefined);
      return 0;
    case 'wrong-request-id':
      write({ ...response, requestId: 'req-someone-else' });
      return 0;
    case 'wrong-kind':
      write(
        errorResponse(
          request.requestId,
          request.kind === 'hello' ? 'workflow.signal.submit' : 'hello',
          codes.INTERNAL,
          'wrong kind fault',
        ),
      );
      return 0;
    case 'null-correlation':
      write(errorResponse(null, null, codes.INTERNAL, 'null correlation fault'));
      return 0;
    case 'wrong-event-id':
      write({
        version: { axis: 'accepted-operation', version: PROTOCOL_VERSION },
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
