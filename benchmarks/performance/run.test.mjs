// These tests validate fixtures and aggregation without requiring Linux storage support.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  JOURNAL_SCALE_CASES,
  MAX_PAYLOAD_CASES,
  OUTCOME_CASES,
  percentile,
  summarizeValues,
  TRANSPORT_CASES,
  validateCase,
} from './matrix.mjs';
import {
  aggregateSamples,
  buildRequest,
  classifyResponse,
  compareWatchdog,
  parseArgs,
  renderSummary,
  seedFixture,
} from './run.mjs';

test('purpose-specific matrices contain the exact valid boundaries', () => {
  assert.deepEqual(
    JOURNAL_SCALE_CASES.filter((entry) => entry.name.startsWith('submit_accepted_')).map(
      (entry) => entry.journal_entries_before_operation,
    ),
    [0, 10, 100, 1_000, 9_999],
  );
  assert.deepEqual(
    JOURNAL_SCALE_CASES.filter((entry) => entry.name.startsWith('submit_duplicate_')).map(
      (entry) => entry.journal_entries_before_operation,
    ),
    [1, 10, 100, 1_000, 10_000],
  );
  assert.ok(
    OUTCOME_CASES.some(
      (entry) =>
        entry.expected_error_code === 'JOURNAL_BOUND_EXCEEDED' &&
        entry.journal_entries_before_operation === 10_000,
    ),
  );
  assert.deepEqual(
    TRANSPORT_CASES.filter((entry) => entry.name.startsWith('lookup_')).map(
      (entry) => entry.journal_entries_before_operation,
    ),
    [0, 100, 10_000],
  );
  assert.throws(
    () =>
      validateCase({
        name: 'invalid_accepted_bound',
        operation_kind: 'workflow.signal.submit',
        expected_outcome: 'accepted',
        fixture_target: 'absent',
        journal_entries_before_operation: 10_000,
      }),
    /cannot start at the journal bound/,
  );
  assert.throws(
    () =>
      validateCase({
        name: 'invalid_duplicate_empty',
        expected_outcome: 'duplicate',
        fixture_target: 'exact',
        journal_entries_before_operation: 0,
      }),
    /requires a seeded target|requires at least one entry/,
  );
  assert.deepEqual(
    MAX_PAYLOAD_CASES.map((entry) => [
      entry.operation_kind,
      entry.journal_entries_before_operation,
    ]),
    [
      ['workflow.signal.submit', 1_000],
      ['workflow.signal.submit', 10_000],
      ['workflow.signal.reconcile', 1_000],
      ['workflow.signal.reconcile', 10_000],
    ],
  );
});

test('fixture writer publishes an exact metadata-only committed prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-benchmark-fixture-'));
  try {
    const state = join(root, 'state');
    seedFixture(state, 10, 'exact');
    const journal = readFileSync(join(state, 'workflow.jsonl'));
    const commit = JSON.parse(readFileSync(join(state, 'workflow.commit.json'), 'utf8'));
    assert.equal(commit.committedBytes, journal.length);
    assert.equal(commit.committedEntries, 10);
    assert.equal(commit.sha256, createHash('sha256').update(journal).digest('hex'));
    assert.equal(journal.toString('utf8').trimEnd().split('\n').length, 10);
    assert.equal(
      JSON.parse(journal.toString('utf8').trimEnd().split('\n').at(-1)).signal.eventId,
      'evt-benchmark-target',
    );
    assert.equal(statSync(state).mode & 0o777, 0o700);
    for (const name of ['workflow.lock', 'workflow.jsonl', 'workflow.commit.json']) {
      assert.equal(statSync(join(state, name)).mode & 0o777, 0o600);
    }
    for (const forbidden of ['prompt', 'reasoning', 'credential', 'sessionId']) {
      assert.ok(!journal.includes(forbidden));
    }

    const nearMaxState = join(root, 'near-max-state');
    seedFixture(nearMaxState, 1, 'exact', 'near_max');
    const nearMaxRecord = JSON.parse(
      readFileSync(join(nearMaxState, 'workflow.jsonl'), 'utf8').trim(),
    );
    assert.equal(nearMaxRecord.signal.eventId.length, 128);
    assert.equal(nearMaxRecord.signal.workflowId.length, 128);
    assert.equal(nearMaxRecord.signal.artifactRef.length, 256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('request fixtures preserve operation validity and response classification', () => {
  const rejected = OUTCOME_CASES.find((entry) => entry.name === 'submit_rejected');
  const request = buildRequest(rejected);
  assert.equal(request.payload.expected.artifactRevision, 'rev-mismatch');
  assert.equal(request.payload.signal.artifactRevision, 'rev-benchmark');
  assert.deepEqual(
    classifyResponse({ ok: false, error: { code: 'EVENT_CONFLICT' } }, 'workflow.signal.submit'),
    { outcome: 'conflict', error_code: 'EVENT_CONFLICT' },
  );
  assert.deepEqual(
    classifyResponse({ ok: false, error: { code: 'JOURNAL_LOCKED' } }, 'workflow.signal.reconcile'),
    {
      outcome: 'unknown',
      error_code: 'JOURNAL_LOCKED',
      unknown_reason: 'reported_unknown',
    },
  );
  const nearMax = buildRequest(MAX_PAYLOAD_CASES[0]);
  assert.equal(nearMax.payload.expected.workflowId.length, 128);
  assert.equal(nearMax.payload.signal.eventId.length, 128);
  assert.equal(nearMax.payload.signal.artifactRef.length, 256);
  assert.equal(nearMax.payload.signal.kind, 'repair_submitted');
});

test('nearest-rank summaries always carry their sample count', () => {
  assert.equal(percentile([1, 2, 3, 4, 100], 0.95), 100);
  assert.deepEqual(summarizeValues([1, 2, 3, 4]), {
    sample_count: 4,
    p50: 2,
    p95: 4,
    p99: 4,
    min: 1,
    max: 4,
  });
});

test('aggregation uses warm samples and summary explicitly avoids a budget claim', () => {
  const samples = [
    {
      sweep: 'outcomes',
      case_name: 'submit_accepted',
      sample_phase: 'new_process_new_open',
      transport: 'rust_direct',
      outcome: 'accepted',
      child: { handler_total_ms: 99 },
      parent: { spawn_to_exit_ms: 120 },
    },
    ...[10, 20, 30].map((handler, index) => ({
      sweep: 'outcomes',
      case_name: 'submit_accepted',
      sample_phase: 'warm_repeated',
      sample_index: index,
      transport: 'rust_direct',
      operation_kind: 'workflow.signal.submit',
      journal_entries_before_operation: 100,
      outcome: 'accepted',
      child: { handler_total_ms: handler },
      parent: { spawn_to_exit_ms: handler + 5 },
    })),
  ];
  const aggregates = aggregateSamples(samples);
  assert.equal(aggregates[0].metrics.handler_total_ms.sample_count, 3);
  assert.equal(aggregates[0].metrics.handler_total_ms.p50, 20);
  const watchdog = compareWatchdog(aggregates);
  assert.equal(watchdog.slowest_handler_p99_ms, 30);
  assert.equal(watchdog.headroom_ms, 9_970);
  const summary = renderSummary({
    metadata: {
      generated_at: '2026-08-24T00:00:00.000Z',
      commit_sha: 'abc',
      working_tree_dirty: false,
      os: 'linux',
      arch: 'x64',
      cpu_model: 'test cpu',
      filesystem: 'ext2/ext3',
      rust_version: 'rustc test',
      node_version: 'v24',
      runner_version: 1,
    },
    config: { warmup: 1, samples: 3 },
    watchdog,
    aggregates,
  });
  assert.match(summary, /not a performance budget or CI gate/);
  assert.match(summary, /20\.000 \/ 30\.000 \/ 30\.000 \(3\)/);
  assert.match(summary, /9970\.000 ms headroom/);
});

test('runner arguments keep sweeps independent', () => {
  const parsed = parseArgs([
    '--binary',
    '/tmp/aizign',
    '--warmup',
    '0',
    '--samples',
    '2',
    '--sweeps',
    'outcomes,max-payload,dsh',
  ]);
  assert.equal(parsed.warmup, 0);
  assert.equal(parsed.samples, 2);
  assert.deepEqual(parsed.sweeps, ['outcomes', 'max-payload', 'dsh']);
});
