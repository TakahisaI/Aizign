import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeResponse,
  encodeRequest,
  encodeResponse,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BYTES,
  type Request,
} from './envelope.ts';
import { codes, ProtocolError } from './error.ts';

test('encoded frames are single lines with escaped newlines', () => {
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

test('extractFrame accepts exactly one newline-terminated frame plus whitespace', async () => {
  const { extractFrame } = await import('./envelope.ts');
  const text = new TextDecoder('utf-8', { fatal: true });
  const first = extractFrame('{"a":1}\n');
  assert.equal(first.kind, 'frame');
  if (first.kind === 'frame') assert.equal(text.decode(first.frame), '{"a":1}');
  const padded = extractFrame('{"a":1}\n  \n\t');
  assert.equal(padded.kind, 'frame');
  if (padded.kind === 'frame') assert.equal(text.decode(padded.frame), '{"a":1}');
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
