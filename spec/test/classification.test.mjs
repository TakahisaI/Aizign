import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  codes,
} from '@aizign/protocol';
import { Ajv2020 } from 'ajv/dist/2020.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const corpusPath = join(root, 'spec/classification/current-operations.json');
const schemaPath = join(root, 'spec/classification/current-operations.schema.json');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const validate = new Ajv2020({ allErrors: true }).compile(schema);

const operations = ['hello', 'workflow.signal.submit', 'workflow.signal.reconcile'];
const unknownFixedCodes = new Set(['INTERNAL', 'HANDLER_TIMEOUT', 'JOURNAL_OUTCOME_UNKNOWN']);

function rowKey(row) {
  return JSON.stringify([
    row.operation,
    row.responseCase.kind,
    row.responseCase.disposition ?? null,
    row.reportedCode.kind,
    row.reportedCode.value ?? null,
  ]);
}

function fixedCodes(rows = corpus.rows) {
  return new Set(
    rows.filter((row) => row.reportedCode.kind === 'fixed').map((row) => row.reportedCode.value),
  );
}

function markdownTableHeaders(text) {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => {
    if (!/^\|(?:\s*:?-+:?\s*\|)+$/.test(lines[index + 1] ?? '')) return [];
    return [
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim().replaceAll('`', '').toLowerCase()),
    ];
  });
}

function isClassificationColumn(cell) {
  const sourceQualified =
    /(server|client|reconciliation|child|parent)/.test(cell) &&
    /(disposition|outcome|observation)/.test(cell);
  const oldOperationQualified = /^(submit|reconcile) (server|client|child|parent)/.test(cell);
  return sourceQualified || oldOperationQualified;
}

test('the current-operation corpus validates and closes all 78 legal keys', () => {
  assert.equal(validate(corpus), true, JSON.stringify(validate.errors));
  assert.equal(corpus.rows.length, 78);
  assert.deepEqual(
    [...new Set(corpus.rows.map((row) => row.operation))].sort(),
    [...operations].sort(),
  );
  assert.equal(new Set(corpus.rows.map(rowKey)).size, 78);
  assert.equal(corpus.rows.filter((row) => row.responseCase.kind === 'success').length, 6);
  assert.equal(fixedCodes().size, 23);
  assert.equal(
    corpus.rows.filter((row) => row.reportedCode.kind === 'wellFormedUnrecognized').length,
    3,
  );
});

test('the schema rejects a duplicate composite key even when semantics differ', () => {
  const invalid = structuredClone(corpus);
  invalid.rows[1] = {
    ...structuredClone(invalid.rows[0]),
    clientOutcome: 'unknown',
    childObservation: { field: 'outcome', value: 'unknown' },
  };
  assert.equal(validate(invalid), false);
  assert.ok(
    validate.errors?.some(
      (error) =>
        error.keyword === 'contains' &&
        error.params.minContains === 1 &&
        error.params.maxContains === 1,
    ),
    JSON.stringify(validate.errors),
  );
});

test('the corpus preserves the accepted fail-closed source-qualified semantics', () => {
  for (const row of corpus.rows) {
    assert.equal(row.automaticRetryAuthorized, false);
    assert.equal(row.childObservation?.field, 'outcome');
    assert.equal(row.parentObservation?.field, 'outcome');

    if (row.reportedCode.kind === 'fixed') {
      assert.equal(row.timingCodeDisclosure, true);
    } else {
      assert.equal(row.timingCodeDisclosure, false);
    }

    if (row.responseCase.kind === 'success') {
      const { disposition } = row.responseCase;
      assert.equal(
        row.serverDisposition,
        row.operation === 'workflow.signal.submit' ? disposition : null,
      );
      assert.equal(
        row.reconciliationDisposition,
        row.operation === 'workflow.signal.reconcile' ? disposition : null,
      );
    } else {
      assert.equal(row.serverDisposition, null);
      assert.equal(row.reconciliationDisposition, null);
    }

    if (row.reportedCode.kind === 'wellFormedUnrecognized') {
      assert.equal(row.clientOutcome, 'unknown');
      assert.equal(row.childObservation.value, 'unknown');
      assert.equal(row.parentObservation.value, 'unknown');
      continue;
    }
    if (row.responseCase.kind === 'success') continue;

    const code = row.reportedCode.value;
    if (row.operation === 'workflow.signal.reconcile') {
      assert.equal(row.clientOutcome, 'unknown');
      assert.equal(row.reconciliationDisposition, null);
      assert.equal(row.childObservation.value, 'unknown');
      assert.equal(row.parentObservation.value, 'unknown');
    } else if (unknownFixedCodes.has(code)) {
      assert.equal(row.clientOutcome, 'unknown');
      assert.equal(row.childObservation.value, 'unknown');
      assert.equal(row.parentObservation.value, 'unknown');
    } else if (row.operation === 'hello') {
      assert.equal(row.clientOutcome, 'error');
      assert.equal(row.childObservation.value, 'error');
      assert.equal(row.parentObservation.value, 'error');
    } else {
      assert.equal(row.clientOutcome, 'rejected');
      assert.equal(row.childObservation.value, code === 'EVENT_CONFLICT' ? 'conflict' : 'rejected');
      assert.equal(
        row.parentObservation.value,
        code === 'EVENT_CONFLICT' ? 'conflict' : 'rejected',
      );
    }
  }
});

test('classification Markdown cannot regain a second normative row table', () => {
  const readme = readFileSync(join(root, 'spec/classification/README.md'), 'utf8');
  for (const oldSignature of [
    '### Successful responses',
    '### Error responses and fixed codes',
    'Server disposition | Client outcome | Reconciliation disposition',
    'Submit server | Submit client | Submit child | Submit parent',
  ]) {
    assert.equal(readme.includes(oldSignature), false, oldSignature);
  }

  for (const header of markdownTableHeaders(readme)) {
    assert.ok(
      header.filter(isClassificationColumn).length < 3,
      `second classification row table detected: ${header.join(' | ')}`,
    );
  }
});

test('wire registries, schema values, corpus, and the non-normative index agree exactly', () => {
  const schemaCodes = new Set(
    schema.$defs.row.properties.reportedCode.oneOf.find(
      (entry) => entry.properties?.kind?.const === 'fixed',
    ).properties.value.enum,
  );
  const indexText = readFileSync(join(root, 'docs/reference/error-codes.md'), 'utf8').split(
    '## Harness-facing',
  )[0];
  const indexCodes = new Set(
    [...indexText.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((match) => match[1]),
  );
  const expected = [...fixedCodes()].sort();

  assert.deepEqual([...schemaCodes].sort(), expected);
  assert.deepEqual(Object.values(codes).sort(), expected);
  assert.deepEqual([...indexCodes].sort(), expected);
  assert.equal(
    expected.some((code) => code.startsWith('EFFECT_')),
    false,
  );
});

test('current operation ownership remains aligned with schemas and capabilities', () => {
  assert.equal(CAPABILITY_WORKFLOW_SIGNAL_SUBMIT, operations[1]);
  assert.equal(CAPABILITY_WORKFLOW_SIGNAL_RECONCILE, operations[2]);
  for (const name of [
    'hello.response.schema.json',
    'workflow-signal-submit.request.schema.json',
    'workflow-signal-submit.response.schema.json',
    'workflow-signal-reconcile.request.schema.json',
    'workflow-signal-reconcile.response.schema.json',
  ]) {
    assert.doesNotThrow(() => readFileSync(join(root, 'spec/protocol/v1/schemas', name), 'utf8'));
  }
});
