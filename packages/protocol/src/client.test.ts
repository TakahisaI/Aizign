import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCorrelation } from './client.ts';
import type { Response } from './envelope.ts';
import { codes, ProtocolError } from './error.ts';

const accepted: Response = {
  requestId: 'req-1',
  kind: 'workflow.signal.submit',
  body: { type: 'workflow.signal', result: { disposition: 'accepted', eventId: 'evt-1' } },
};

test('a response correlates only when request id, kind, and event id all match', () => {
  const sent = { requestId: 'req-1', kind: 'workflow.signal.submit', eventId: 'evt-1' };
  assert.equal(checkCorrelation(sent, accepted), undefined);
  assert.equal(checkCorrelation(sent, { ...accepted, requestId: 'req-2' })?.field, 'requestId');
  assert.equal(checkCorrelation(sent, { ...accepted, requestId: null })?.field, 'requestId');
  assert.equal(checkCorrelation(sent, { ...accepted, kind: 'hello' })?.field, 'kind');
  assert.equal(
    checkCorrelation(sent, {
      ...accepted,
      body: { type: 'workflow.signal', result: { disposition: 'accepted', eventId: 'evt-9' } },
    })?.field,
    'eventId',
  );
});

test('error responses correlate on request id and kind; the event id cannot be checked', () => {
  const sent = { requestId: 'req-1', kind: 'workflow.signal.submit', eventId: 'evt-1' };
  const rejected: Response = {
    requestId: 'req-1',
    kind: 'workflow.signal.submit',
    body: { type: 'error', error: new ProtocolError(codes.INVALID_SIGNAL, 'm') },
  };
  assert.equal(checkCorrelation(sent, rejected), undefined);
  assert.equal(checkCorrelation(sent, { ...rejected, kind: 'hello' })?.field, 'kind');
});
