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

test('extractFrame accepts exactly one newline-terminated frame plus whitespace', async () => {
  const { extractFrame } = await import('./envelope.ts');
  assert.deepEqual(extractFrame('{"a":1}\n'), { kind: 'frame', frame: '{"a":1}' });
  assert.deepEqual(extractFrame('{"a":1}\n  \n\t'), { kind: 'frame', frame: '{"a":1}' });
  assert.deepEqual(extractFrame(''), { kind: 'empty' });
  assert.deepEqual(extractFrame('\n'), { kind: 'empty' });
  assert.equal(extractFrame('{"a":1}').kind, 'extra', 'a frame that never ended');
  assert.equal(extractFrame('{"a":1}\n{"b":2}\n').kind, 'extra', 'two frames');
  assert.equal(extractFrame('{"a":1}\nprose').kind, 'extra', 'trailing content');
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
