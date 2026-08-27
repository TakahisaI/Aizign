import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emitBestEffort, isTimingErrorCode, parentTimingOutcome } from '../../src/timing.ts';

test('DSH timing keeps a closed fixed-code disclosure allowlist', () => {
  assert.equal(isTimingErrorCode('EVENT_CONFLICT'), true);
  assert.equal(isTimingErrorCode('JOURNAL_OUTCOME_UNKNOWN'), true);
  assert.equal(isTimingErrorCode('INTERNAL'), true);
  assert.equal(isTimingErrorCode('FUTURE_OUTCOME_UNKNOWN'), false);
});

test('DSH timing preserves unknown before submit conflict normalization', () => {
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

test('DSH timing emission isolates synchronous and asynchronous sink failure', async () => {
  emitBestEffort(() => {
    throw new Error('synchronous sink failure');
  }, 1);
  emitBestEffort(async () => {
    throw new Error('asynchronous sink failure');
  }, 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
});
