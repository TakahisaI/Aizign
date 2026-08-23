import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeResponse, encodeRequest, encodeResponse, type Request } from './envelope.ts';
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
    '{"protocol":"aizu","version":1,"requestId":"req-1","kind":"hello","payload":{}}',
  );
});

test('malformed codes degrade to INTERNAL rather than reaching the wire', () => {
  assert.equal(new ProtocolError('not a code', 'm').code, codes.INTERNAL);
});
