import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { classifyCorrelatedOutcome } from '../../src/core-client/one-shot-client.ts';
import type { ParentOperationKind, TimingOutcome } from '../../src/timing.ts';

interface CorpusRow {
  readonly operation: Exclude<ParentOperationKind, 'preflight'>;
  readonly responseCase:
    | {
        readonly kind: 'success';
        readonly disposition: 'ok' | 'accepted' | 'duplicate' | 'conflict' | 'absent';
      }
    | { readonly kind: 'error' };
  readonly reportedCode:
    | { readonly kind: 'none' }
    | { readonly kind: 'fixed'; readonly value: string }
    | { readonly kind: 'wellFormedUnrecognized' };
  readonly clientOutcome: TimingOutcome;
}

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../spec/classification/current-operations.json', import.meta.url),
    'utf8',
  ),
) as { readonly rows: readonly CorpusRow[] };

test('the production DSH client projection follows all 78 corpus rows', () => {
  assert.equal(corpus.rows.length, 78);
  for (const row of corpus.rows) {
    const reportedCode =
      row.reportedCode.kind === 'fixed'
        ? row.reportedCode.value
        : row.reportedCode.kind === 'wellFormedUnrecognized'
          ? 'FUTURE_OUTCOME_UNKNOWN'
          : undefined;
    assert.equal(
      classifyCorrelatedOutcome(row.operation, row.responseCase, reportedCode),
      row.clientOutcome,
      `${row.operation} / ${JSON.stringify(row.responseCase)} / ${JSON.stringify(row.reportedCode)}`,
    );
  }
});
