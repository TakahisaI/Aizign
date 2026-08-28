import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCorrelation } from './client.ts';
import type { Response } from './envelope.ts';
import { codes, ProtocolError } from './error.ts';

const accepted: Response = {
  version: { axis: 'accepted-operation', version: 1 },
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
    version: { axis: 'accepted-operation', version: 1 },
    requestId: 'req-1',
    kind: 'workflow.signal.submit',
    body: { type: 'error', error: new ProtocolError(codes.INVALID_SIGNAL, 'm') },
  };
  assert.equal(checkCorrelation(sent, rejected), undefined);
  assert.equal(checkCorrelation(sent, { ...rejected, kind: 'hello' })?.field, 'kind');
});

test('reconciliation success also correlates the queried event id', () => {
  const sent = { requestId: 'req-r', kind: 'workflow.signal.reconcile', eventId: 'evt-1' };
  const response: Response = {
    version: { axis: 'accepted-operation', version: 1 },
    requestId: 'req-r',
    kind: 'workflow.signal.reconcile',
    body: {
      type: 'workflow.signal.reconciliation',
      result: { disposition: 'absent', eventId: 'evt-1' },
    },
  };
  assert.equal(checkCorrelation(sent, response), undefined);
  assert.equal(
    checkCorrelation(sent, {
      ...response,
      body: {
        type: 'workflow.signal.reconciliation',
        result: { disposition: 'absent', eventId: 'evt-other' },
      },
    })?.field,
    'eventId',
  );
});

test('correlation does not reinterpret the response version axis', () => {
  const futureOperation = {
    ...accepted,
    version: { axis: 'accepted-operation' as const, version: 2 },
  };
  assert.equal(
    checkCorrelation(
      { requestId: 'req-1', kind: 'workflow.signal.submit', eventId: 'evt-1' },
      futureOperation,
    ),
    undefined,
  );
  assert.deepEqual(futureOperation.version, { axis: 'accepted-operation', version: 2 });
});
