import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkCorrelation,
  emitBestEffort,
  isSubmitRejectionCode,
  parentTimingOutcome,
} from './client.ts';
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

test('reconciliation success also correlates the queried event id', () => {
  const sent = { requestId: 'req-r', kind: 'workflow.signal.reconcile', eventId: 'evt-1' };
  const response: Response = {
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

test('parent timing preserves unknown before submit conflict normalization', () => {
  assert.equal(
    parentTimingOutcome('workflow.signal.submit', 'rejected', 'EVENT_CONFLICT'),
    'conflict',
  );
  assert.equal(
    parentTimingOutcome('workflow.signal.reconcile', 'unknown', 'EVENT_CONFLICT'),
    'unknown',
  );
  assert.equal(
    parentTimingOutcome('workflow.signal.submit', 'unknown', 'EVENT_CONFLICT'),
    'unknown',
  );
});

test('submit rejection classification is closed and fails unknown codes safely', () => {
  assert.equal(isSubmitRejectionCode('EVENT_CONFLICT'), true);
  assert.equal(isSubmitRejectionCode('JOURNAL_UNAVAILABLE'), true);
  assert.equal(isSubmitRejectionCode('JOURNAL_OUTCOME_UNKNOWN'), false);
  assert.equal(isSubmitRejectionCode('INTERNAL'), false);
  assert.equal(isSubmitRejectionCode('FUTURE_OUTCOME_UNKNOWN'), false);
});

test('best-effort timing isolates synchronous throws and asynchronous rejection', async () => {
  emitBestEffort(() => {
    throw new Error('synchronous sink failure');
  }, 1);
  emitBestEffort(async () => {
    throw new Error('asynchronous sink failure');
  }, 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
});
