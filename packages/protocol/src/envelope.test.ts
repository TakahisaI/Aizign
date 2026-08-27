import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOOTSTRAP_ENVELOPE_VERSION,
  DecodeFailure,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BYTES,
  OneShotFrameCollector,
  type Request,
} from './envelope.ts';
import { codes, ProtocolError } from './error.ts';

const PROCESS_PROFILE_CASE_IDS = [
  'hello-future-operation',
  'version-bootstrap-unsupported',
  'version-submit-unsupported',
  'version-reconcile-unsupported',
  'version-future-kind-unsupported',
  'kind-future-accepted-version',
] as const;

test('process profile case IDs are unique', () => {
  assert.equal(new Set(PROCESS_PROFILE_CASE_IDS).size, PROCESS_PROFILE_CASE_IDS.length);
});

test('version axis selection precedes kind membership', () => {
  const failure = (kind: unknown, version: number) => {
    try {
      decodeRequest(
        JSON.stringify({
          protocol: 'aizign',
          version,
          requestId: 'req-version-axis',
          kind,
          payload: {},
        }),
      );
      assert.fail('request unexpectedly decoded');
    } catch (error) {
      assert.ok(error instanceof DecodeFailure);
      return error;
    }
  };

  assert.equal(failure('hello', 2).error.code, codes.PROTOCOL_VERSION_UNSUPPORTED);
  assert.equal(failure('workflow.signal.submit', 2).error.code, codes.PROTOCOL_VERSION_UNSUPPORTED);
  assert.equal(
    failure('workflow.signal.reconcile', 2).error.code,
    codes.PROTOCOL_VERSION_UNSUPPORTED,
  );
  assert.equal(failure('future.operation', 2).error.code, codes.PROTOCOL_VERSION_UNSUPPORTED);
  assert.equal(failure('future.operation', 1).error.code, codes.UNKNOWN_KIND);
  assert.equal(failure(17, 2).error.code, codes.INVALID_ENVELOPE);
});

test('encoded frames are single lines with escaped newlines', () => {
  assert.equal(BOOTSTRAP_ENVELOPE_VERSION, 1);
  const frame = encodeResponse({
    requestId: null,
    kind: null,
    body: { type: 'error', error: new ProtocolError(codes.INTERNAL, 'line one\nline two') },
  });
  assert.ok(!frame.includes('\n'));
  const decoded = decodeResponse(frame);
  assert.equal(decoded.body.type, 'error');
  assert.equal(decoded.requestId, null);

  const request: Request = { requestId: 'req-1', kind: 'hello' };
  assert.equal(
    encodeRequest(request),
    '{"protocol":"aizign","version":1,"requestId":"req-1","kind":"hello","payload":{}}',
  );
});

test('malformed codes degrade to INTERNAL rather than reaching the wire', () => {
  assert.equal(new ProtocolError('not a code', 'm').code, codes.INTERNAL);
});

test('oversized requests are rejected by the encoder before transport', () => {
  assert.throws(
    () =>
      encodeRequest({
        requestId: `r${'x'.repeat(MAX_REQUEST_BYTES)}`,
        kind: 'hello',
      }),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.REQUEST_TOO_LARGE,
  );
});

test('the response encoder never emits an oversized frame', () => {
  assert.throws(
    () =>
      encodeResponse({
        requestId: 'req-1',
        kind: 'workflow.signal.submit',
        body: {
          type: 'error',
          error: new ProtocolError(codes.INTERNAL, 'x'.repeat(MAX_FRAME_BYTES)),
        },
      }),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
  );
});

test('encoders reject ill-formed Unicode before returning a frame', () => {
  const isInvalidEnvelope = (error: unknown) =>
    error instanceof ProtocolError &&
    error.code === codes.INVALID_ENVELOPE &&
    error.message.includes('well-formed Unicode');

  assert.throws(
    () => encodeRequest({ requestId: '\ud800', kind: 'hello' }),
    isInvalidEnvelope,
    'request encoder returned a frame containing a lone surrogate',
  );
  assert.throws(
    () =>
      encodeResponse({
        requestId: null,
        kind: null,
        body: {
          type: 'error',
          error: new ProtocolError(codes.INTERNAL, '\ud800'),
        },
      }),
    isInvalidEnvelope,
    'response encoder returned a frame containing a lone surrogate',
  );
});

test('extractFrame accepts exactly one LF-terminated frame and immediate close', async () => {
  const { extractFrame } = await import('./envelope.ts');
  const text = new TextDecoder('utf-8', { fatal: true });
  const first = extractFrame('{"a":1}\n');
  assert.equal(first.kind, 'frame');
  if (first.kind === 'frame') assert.equal(text.decode(first.frame), '{"a":1}');
  assert.equal(extractFrame('{"a":1}\n ').kind, 'extra');
  assert.equal(extractFrame('{"a":1}\n\t').kind, 'extra');
  assert.equal(extractFrame('{"a":1}\n\n').kind, 'extra');
  assert.equal(extractFrame('{"a":1}\r\n').kind, 'extra');
  assert.deepEqual(extractFrame(''), { kind: 'empty' });
  assert.deepEqual(extractFrame('\n'), { kind: 'empty' });
  assert.equal(extractFrame('{"a":1}').kind, 'extra', 'a frame that never ended');
  assert.equal(extractFrame('{"a":1}\n{"b":2}\n').kind, 'extra', 'two frames');
  assert.equal(extractFrame('{"a":1}\nprose').kind, 'extra', 'trailing content');
  assert.equal(extractFrame('{"a":1}\n\u00a0').kind, 'extra', 'Unicode whitespace is content');

  const invalidUtf8 = Uint8Array.from([0x7b, 0xff, 0x7d, 0x0a]);
  const invalidFrame = extractFrame(invalidUtf8);
  assert.equal(invalidFrame.kind, 'frame');
  if (invalidFrame.kind === 'frame') {
    assert.deepEqual([...invalidFrame.frame], [0x7b, 0xff, 0x7d]);
    assert.throws(
      () => decodeResponse(invalidFrame.frame),
      (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
    );
  }
});

test('the process collector bounds the body and rejects every byte after LF', () => {
  const exact = new OneShotFrameCollector(4);
  assert.equal(exact.append(Uint8Array.from([0x31, 0x32])), true);
  assert.equal(exact.append(Uint8Array.from([0x33, 0x34, 0x0a])), true);
  const extraction = exact.extract();
  assert.equal(extraction.kind, 'frame');
  if (extraction.kind === 'frame')
    assert.deepEqual([...extraction.frame], [0x31, 0x32, 0x33, 0x34]);

  const oversized = new OneShotFrameCollector(4);
  assert.equal(oversized.append(Uint8Array.from([0x31, 0x32, 0x33, 0x34])), true);
  assert.equal(oversized.append(Uint8Array.from([0x35, 0x0a])), false);
  assert.equal(oversized.extract().kind, 'oversized');

  const trailingContent = new OneShotFrameCollector(4);
  assert.equal(trailingContent.append(Uint8Array.from([0x31, 0x0a, 0x20])), true);
  assert.equal(trailingContent.extract().kind, 'extra');

  const crlf = new OneShotFrameCollector(4);
  assert.equal(crlf.append(Uint8Array.from([0x31, 0x0d, 0x0a])), true);
  assert.equal(crlf.extract().kind, 'extra');
});

test('oversized or badly addressed responses are invalid envelopes', async () => {
  const { MAX_FRAME_BYTES } = await import('./envelope.ts');
  const big = `{"protocol":"aizign","version":1,"requestId":"r","kind":"hello","ok":false,"error":{"code":"INTERNAL","message":"${'x'.repeat(MAX_FRAME_BYTES)}"}}`;
  assert.throws(
    () => decodeResponse(big),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
  );
  const bad =
    '{"protocol":"aizign","version":1,"requestId":"bad id","kind":"hello","ok":false,"error":{"code":"INTERNAL","message":"m"}}';
  assert.throws(
    () => decodeResponse(bad),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
  );
});
