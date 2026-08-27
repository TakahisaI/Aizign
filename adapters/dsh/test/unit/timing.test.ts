import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  emitBestEffort,
  isTimingErrorCode,
  type ParentOperationKind,
  parentTimingOutcome,
  type TimingOutcome,
} from '../../src/timing.ts';

interface CorpusRow {
  readonly operation: Exclude<ParentOperationKind, 'preflight'>;
  readonly reportedCode:
    | { readonly kind: 'none' }
    | { readonly kind: 'fixed'; readonly value: string }
    | { readonly kind: 'wellFormedUnrecognized' };
  readonly clientOutcome: TimingOutcome;
  readonly parentObservation: { readonly field: 'outcome'; readonly value: TimingOutcome };
  readonly timingCodeDisclosure: boolean;
}

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../spec/classification/current-operations.json', import.meta.url),
    'utf8',
  ),
) as { readonly rows: readonly CorpusRow[] };

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

test('DSH parent timing and fixed-code disclosure follow every corpus row', () => {
  assert.equal(corpus.rows.length, 78);
  for (const row of corpus.rows) {
    const reportedCode =
      row.reportedCode.kind === 'fixed'
        ? row.reportedCode.value
        : row.reportedCode.kind === 'wellFormedUnrecognized'
          ? 'FUTURE_OUTCOME_UNKNOWN'
          : undefined;
    assert.equal(
      reportedCode === undefined ? false : isTimingErrorCode(reportedCode),
      row.timingCodeDisclosure,
    );
    assert.equal(
      parentTimingOutcome(
        row.operation,
        row.clientOutcome,
        row.timingCodeDisclosure ? reportedCode : undefined,
      ),
      row.parentObservation.value,
      `${row.operation} / ${JSON.stringify(row.reportedCode)}`,
    );
  }
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
