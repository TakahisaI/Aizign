// These tests validate fixtures and aggregation without requiring Linux storage support.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isTimingErrorCode } from '@aizign/adapter-dsh/experimental/transport';
import {
  checkCorrelation,
  decodeResponse,
  encodeRequest,
  extractFrame,
  MAX_FRAME_BYTES,
  OneShotFrameCollector,
} from '@aizign/protocol';
import { createProcessProfileRegistry } from '../../spec/process/v1/fixtures/registry.mjs';
import { BoundedBuffer } from './bounded-buffer.mjs';
import {
  evaluatePrSmokeBudgets,
  NATIVE_BASELINE_MANIFEST,
  PR_SMOKE_AGGREGATE_IDENTITIES,
  PR_SMOKE_BUDGET_IDS,
  PR_SMOKE_BUDGETS,
  PR_SMOKE_CONFIG,
} from './budget.mjs';
import { dropsAcknowledgement, proxyFailureFrame, requestKind } from './lost-ack-proxy.mjs';
import {
  JOURNAL_SCALE_CASES,
  MAX_PAYLOAD_CASES,
  OUTCOME_CASES,
  PR_SMOKE_CASES,
  PR_SMOKE_CONCURRENCY_LEVELS,
  PR_SMOKE_CONCURRENCY_MODES,
  percentile,
  summarizeValues,
  TRANSPORT_CASES,
  validateCase,
} from './matrix.mjs';
import {
  aggregateSamples,
  assertArtifactPrivacy,
  assertConcurrencySemantics,
  assertDirectChildTiming,
  assertDirectTransport,
  assertScenarioTimingSequence,
  buildRequest,
  classifyResponse,
  compareWatchdog,
  createLostAckExecutable,
  createTimingExecutable,
  decodeCorrelatedResponse,
  executeConcurrencyBatch,
  executeScenario,
  MAX_BENCHMARK_STDERR_BYTES,
  main,
  parseArgs,
  RUNNER_VERSION,
  renderStageAttribution,
  renderSummary,
  runProcess,
  seedFixture,
  TYPESCRIPT_TRANSPORT,
  writeSmokeFailure,
} from './run.mjs';

const PROTOCOL = {
  checkCorrelation,
  decodeResponse,
  encodeRequest,
  extractFrame,
  isTimingErrorCode,
  MAX_FRAME_BYTES,
  OneShotFrameCollector,
};

const CLASSIFICATION_ROWS = JSON.parse(
  readFileSync(
    join(
      fileURLToPath(new URL('../..', import.meta.url)),
      'spec/classification/current-operations.json',
    ),
    'utf8',
  ),
).rows;

test('runner v8 names the production TypeScript transport explicitly', () => {
  assert.equal(RUNNER_VERSION, 8);
  assert.equal(TYPESCRIPT_TRANSPORT, 'typescript_dsh');
});

function renderAggregates(aggregates, samples = 2) {
  return renderSummary({
    metadata: {
      generated_at: '2026-08-25T00:00:00.000Z',
      commit_sha: 'abc',
      working_tree_dirty: false,
      os: 'linux',
      arch: 'x64',
      cpu_model: 'test cpu',
      filesystem: 'ext2/ext3',
      github_runner_image: 'ubuntu24',
      github_runner_image_version: 'test',
      rust_version: 'rustc test',
      node_version: 'v24',
      runner_version: 3,
    },
    config: { warmup: 0, samples },
    watchdog: compareWatchdog(aggregates),
    aggregates,
  });
}

function canonicalSmokeFixture() {
  const samples = [];
  for (const benchmarkCase of PR_SMOKE_CASES) {
    for (let index = 0; index < PR_SMOKE_CONFIG.samples; index += 1) {
      samples.push({
        sweep: 'transport',
        case_name: benchmarkCase.name,
        sample_phase: 'warm_repeated',
        sample_index: index,
        transport: 'rust_direct',
        operation_kind: benchmarkCase.operation_kind,
        journal_entries_before_operation: benchmarkCase.journal_entries_before_operation,
        outcome: benchmarkCase.expected_outcome,
        ...(benchmarkCase.expected_error_code === undefined
          ? {}
          : { error_code: benchmarkCase.expected_error_code }),
        child: {
          handler_total_ms: 10 + index,
          decide_us: 0.531 + index,
          append_sync_ms: 2 + index,
        },
        parent: { spawn_to_exit_ms: 20 + index },
      });
    }
  }
  for (const mode of PR_SMOKE_CONCURRENCY_MODES) {
    for (const concurrency of PR_SMOKE_CONCURRENCY_LEVELS) {
      for (let index = 0; index < PR_SMOKE_CONFIG.samples; index += 1) {
        const operations = Array.from({ length: concurrency }, (_, operationIndex) => {
          const locked = mode === 'same_state_dir' && concurrency === 2 && operationIndex === 1;
          return {
            outcome: locked ? 'rejected' : 'accepted',
            ...(locked ? { error_code: 'JOURNAL_LOCKED' } : {}),
            child: { handler_total_ms: 4 + operationIndex },
            parent: {
              operation_kind: 'workflow.signal.submit',
              spawn_to_exit_ms: 5 + operationIndex,
              outcome: locked ? 'rejected' : 'accepted',
              ...(locked ? { error_code: 'JOURNAL_LOCKED' } : {}),
            },
          };
        });
        samples.push({
          sweep: 'concurrency',
          case_name: `submit_${mode}_${concurrency}`,
          sample_phase: 'warm_repeated',
          sample_index: index,
          operation_kind: 'workflow.signal.submit',
          mode,
          concurrency,
          journal_entries_before_batch: 100,
          batch_total_ms: 30 + index,
          successful_operations: operations.filter(({ outcome }) => outcome === 'accepted').length,
          journal_locked: operations.filter(({ error_code }) => error_code === 'JOURNAL_LOCKED')
            .length,
          unexpected_operations: 0,
          throughput_success_ops_per_s: 50,
          operations,
        });
      }
    }
  }
  for (const scenario of ['assignment_submit', 'assignment_unknown_reconcile']) {
    const lostAck = scenario === 'assignment_unknown_reconcile';
    for (let index = 0; index < PR_SMOKE_CONFIG.samples; index += 1) {
      const parentTimings = [
        { operation_kind: 'hello', spawn_to_exit_ms: 1 + index, outcome: 'ok' },
        { operation_kind: 'preflight', preflight_ms: 2 + index, outcome: 'ok' },
        {
          operation_kind: 'workflow.signal.submit',
          spawn_to_exit_ms: 3 + index,
          outcome: lostAck ? 'unknown' : 'accepted',
          ...(lostAck ? { unknown_reason: 'no_response' } : {}),
        },
        ...(lostAck
          ? [
              {
                operation_kind: 'workflow.signal.reconcile',
                spawn_to_exit_ms: 4 + index,
                outcome: 'accepted',
              },
            ]
          : []),
      ];
      samples.push({
        sweep: 'scenarios',
        case_name: scenario,
        sample_phase: 'warm_repeated',
        sample_index: index,
        aizign_end_to_end_ms: 40 + index,
        parent_timings: parentTimings,
        operations: lostAck
          ? [
              {
                name: 'submit_lost_ack',
                outcome: 'unknown',
                unknown_reason: 'no_response',
                parent: parentTimings[2],
              },
              { name: 'lookup', outcome: 'accepted', parent: parentTimings[3] },
            ]
          : [{ name: 'submit', outcome: 'accepted', parent: parentTimings[2] }],
      });
    }
  }
  return {
    config: { ...PR_SMOKE_CONFIG, sweeps: [...PR_SMOKE_CONFIG.sweeps] },
    samples,
    aggregates: aggregateSamples(samples),
  };
}

test('purpose-specific matrices contain the exact valid boundaries', () => {
  assert.deepEqual(
    JOURNAL_SCALE_CASES.filter((entry) => entry.name.startsWith('submit_accepted_')).map(
      (entry) => entry.journal_entries_before_operation,
    ),
    [0, 10, 100, 1_000, 9_999],
  );
  assert.deepEqual(
    PR_SMOKE_CASES.filter((entry) => entry.name.startsWith('accepted_')).map(
      (entry) => entry.journal_entries_before_operation,
    ),
    [0, 100, 9_999],
  );
  assert.deepEqual(
    PR_SMOKE_CASES.filter((entry) => entry.name.startsWith('duplicate_')).map(
      (entry) => entry.journal_entries_before_operation,
    ),
    [1, 100, 10_000],
  );
  assert.deepEqual(PR_SMOKE_CONCURRENCY_LEVELS, [1, 2]);
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
    const publish = JSON.parse(readFileSync(join(state, 'workflow.publish.json'), 'utf8'));
    assert.equal(commit.storeVersion, 2);
    assert.equal(commit.generation, 11);
    assert.equal(commit.committedBytes, journal.length);
    assert.equal(commit.committedEntries, 10);
    assert.equal(commit.sha256, createHash('sha256').update(journal).digest('hex'));
    assert.deepEqual(publish, {
      storeVersion: 2,
      startedGeneration: 11,
      publishedGeneration: 11,
    });
    assert.equal(journal.toString('utf8').trimEnd().split('\n').length, 10);
    assert.equal(
      JSON.parse(journal.toString('utf8').trimEnd().split('\n').at(-1)).signal.eventId,
      'evt-benchmark-target',
    );
    assert.equal(statSync(state).mode & 0o777, 0o700);
    for (const name of [
      'workflow.lock',
      'workflow.jsonl',
      'workflow.commit.json',
      'workflow.publish.json',
    ]) {
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
    classifyResponse(
      { body: { type: 'error', error: { code: 'EVENT_CONFLICT' } } },
      'workflow.signal.submit',
      isTimingErrorCode,
    ),
    { outcome: 'conflict', error_code: 'EVENT_CONFLICT' },
  );
  assert.deepEqual(
    classifyResponse(
      { body: { type: 'error', error: { code: 'JOURNAL_LOCKED' } } },
      'workflow.signal.reconcile',
      isTimingErrorCode,
    ),
    {
      outcome: 'unknown',
      error_code: 'JOURNAL_LOCKED',
      unknown_reason: 'reported_unknown',
    },
  );
  assert.deepEqual(
    classifyResponse(
      { body: { type: 'error', error: { code: 'INTERNAL' } } },
      'workflow.signal.submit',
      isTimingErrorCode,
    ),
    { outcome: 'unknown', error_code: 'INTERNAL', unknown_reason: 'reported_unknown' },
  );
  assert.deepEqual(
    classifyResponse(
      { body: { type: 'error', error: { code: 'FUTURE_OUTCOME_UNKNOWN' } } },
      'workflow.signal.submit',
      isTimingErrorCode,
    ),
    { outcome: 'unknown', unknown_reason: 'reported_unknown' },
  );
  const nearMax = buildRequest(MAX_PAYLOAD_CASES[0]);
  assert.equal(nearMax.payload.expected.workflowId.length, 128);
  assert.equal(nearMax.payload.signal.eventId.length, 128);
  assert.equal(nearMax.payload.signal.artifactRef.length, 256);
  assert.equal(nearMax.payload.signal.kind, 'repair_submitted');
});

test('benchmark normalization follows every classification corpus row', () => {
  assert.equal(CLASSIFICATION_ROWS.length, 78);
  for (const row of CLASSIFICATION_ROWS) {
    let body;
    if (row.responseCase.kind === 'error') {
      body = {
        type: 'error',
        error: {
          code:
            row.reportedCode.kind === 'fixed' ? row.reportedCode.value : 'FUTURE_OUTCOME_UNKNOWN',
        },
      };
    } else if (row.operation === 'hello') {
      body = { type: 'hello' };
    } else if (row.operation === 'workflow.signal.submit') {
      body = { type: 'workflow.signal', result: { disposition: row.responseCase.disposition } };
    } else {
      body = {
        type: 'workflow.signal.reconciliation',
        result: { disposition: row.responseCase.disposition },
      };
    }

    const expected = {
      outcome: row.parentObservation.value,
      ...(row.timingCodeDisclosure ? { error_code: row.reportedCode.value } : {}),
      ...(row.parentObservation.value === 'unknown' ? { unknown_reason: 'reported_unknown' } : {}),
    };
    assert.deepEqual(
      classifyResponse({ body }, row.operation, isTimingErrorCode),
      expected,
      `${row.operation} / ${JSON.stringify(row.responseCase)} / ${JSON.stringify(row.reportedCode)}`,
    );
    assert.equal(row.automaticRetryAuthorized, false);
  }
});

test('direct transport uses the production decoder and correlation contract', () => {
  const request = buildRequest(OUTCOME_CASES[0]);
  const frame = (overrides = {}) =>
    `${JSON.stringify({
      protocol: 'aizign',
      version: 1,
      requestId: request.requestId,
      kind: request.kind,
      ok: true,
      payload: { disposition: 'accepted', eventId: request.payload.signal.eventId },
      ...overrides,
    })}\n`;
  assert.equal(
    decodeCorrelatedResponse(frame(), request, PROTOCOL).transport_kind,
    'correlated_response',
  );
  assert.deepEqual(decodeCorrelatedResponse(frame({ protocol: 'wrong' }), request, PROTOCOL), {
    transport_kind: 'unknown',
    unknown_reason: 'undecodable_response',
  });
  assert.deepEqual(decodeCorrelatedResponse(frame({ version: 2 }), request, PROTOCOL), {
    transport_kind: 'unknown',
    unknown_reason: 'undecodable_response',
  });
  const invalidUtf8 = Buffer.concat([
    Buffer.from(
      `{"protocol":"aizign","version":1,"requestId":"${request.requestId}","kind":"${request.kind}","ok":false,"error":{"code":"INVALID_SIGNAL","message":"`,
    ),
    Buffer.from([0xff]),
    Buffer.from('"}}\n'),
  ]);
  assert.deepEqual(decodeCorrelatedResponse(invalidUtf8, request, PROTOCOL), {
    transport_kind: 'unknown',
    unknown_reason: 'undecodable_response',
  });
  assert.deepEqual(decodeCorrelatedResponse(frame({ requestId: 'req-other' }), request, PROTOCOL), {
    transport_kind: 'unknown',
    unknown_reason: 'correlation_mismatch',
  });
  assert.deepEqual(
    decodeCorrelatedResponse(
      frame({ payload: { disposition: 'accepted', eventId: 'evt-other' } }),
      request,
      PROTOCOL,
    ),
    { transport_kind: 'unknown', unknown_reason: 'correlation_mismatch' },
  );
  assert.throws(
    () =>
      assertDirectChildTiming(
        { name: 'lookup_unknown' },
        {
          transport_kind: 'correlated_response',
          outcome: 'unknown',
          unknown_reason: 'reported_unknown',
        },
      ),
    /child timing was not emitted/,
  );
  assert.doesNotThrow(() =>
    assertDirectChildTiming(
      { name: 'transport_unknown' },
      { transport_kind: 'unknown', outcome: 'unknown', unknown_reason: 'no_response' },
    ),
  );
  const lookupUnknownCase = OUTCOME_CASES.find((entry) => entry.name === 'lookup_unknown');
  const lookupRequest = buildRequest(lookupUnknownCase);
  const mismatchedReportedUnknown = decodeCorrelatedResponse(
    `${JSON.stringify({
      protocol: 'aizign',
      version: 1,
      requestId: 'req-wrong',
      kind: lookupRequest.kind,
      ok: false,
      error: { code: 'JOURNAL_UNAVAILABLE', message: 'unavailable' },
    })}\n`,
    lookupRequest,
    PROTOCOL,
  );
  assert.deepEqual(mismatchedReportedUnknown, {
    transport_kind: 'unknown',
    unknown_reason: 'correlation_mismatch',
    error_code: 'JOURNAL_UNAVAILABLE',
  });
  assert.throws(
    () => assertDirectTransport(lookupUnknownCase, mismatchedReportedUnknown),
    /expected correlated_response, got unknown \(correlation_mismatch\)/,
  );
});

test('bounded buffers preserve UTF-8 chunk boundaries and stop retaining after the limit', () => {
  const encoded = Buffer.from('前後', 'utf8');
  const buffer = new BoundedBuffer(encoded.length);
  assert.equal(buffer.append(encoded.subarray(0, 2)), true);
  assert.equal(buffer.append(encoded.subarray(2)), true);
  assert.equal(buffer.toString(), '前後');
  assert.equal(buffer.append(Buffer.from('x')), false);
  assert.equal(buffer.overflowed, true);
  assert.equal(buffer.receivedBytes, encoded.length + 1);
  assert.equal(buffer.toString(), '前後');
});

test('direct runner bounds the frame, requires immediate close, and fails closed', async () => {
  const processCases = createProcessProfileRegistry('benchmark');
  const root = mkdtempSync(join(tmpdir(), 'aizign-direct-output-bound-'));
  try {
    const fakeBinary = join(root, 'overflow-core.cjs');
    writeFileSync(
      fakeBinary,
      `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (process.argv[2] === 'response') {
    const request = JSON.parse(input);
    const response = {
      protocol: 'aizign',
      version: 1,
      requestId: request.requestId,
      kind: request.kind,
      ok: false,
      error: { code: process.argv[3], message: '' },
    };
    if (process.argv[4] === 'exact-max') {
      const base = Buffer.from(JSON.stringify(response));
      response.error.message = 'x'.repeat(Number(process.argv[5]) - base.length);
      const exact = Buffer.from(JSON.stringify(response));
      if (exact.length !== Number(process.argv[5])) throw new Error('bad exact-max fixture');
      process.stdout.write(Buffer.concat([exact, Buffer.from('\\n')]));
      return;
    }
    process.stdout.write(JSON.stringify(response) + (process.argv[4] === 'post-lf' ? '\\n ' : '\\n'));
    if (process.argv[4] === 'nonzero') process.exitCode = 7;
    return;
  }
  const stream = process.argv[2] === 'stderr' ? process.stderr : process.stdout;
  stream.write(Buffer.alloc(Number(process.argv[3]), 120));
});
`,
      { mode: 0o700 },
    );
    chmodSync(fakeBinary, 0o700);
    const request = buildRequest(OUTCOME_CASES[0]);
    const stdoutResult = await processCases.run('res-over-bound', () =>
      runProcess(
        fakeBinary,
        ['stdout', String(MAX_FRAME_BYTES + 2)],
        request,
        request.kind,
        PROTOCOL,
      ),
    );
    assert.equal(stdoutResult.transport_kind, 'unknown');
    assert.equal(stdoutResult.unknown_reason, 'oversized_response');

    const exactMax = await processCases.run('res-exact-bound', () =>
      runProcess(
        fakeBinary,
        ['response', 'INTERNAL', 'exact-max', String(MAX_FRAME_BYTES)],
        request,
        request.kind,
        PROTOCOL,
      ),
    );
    assert.equal(exactMax.transport_kind, 'correlated_response');
    assert.equal(exactMax.outcome, 'unknown');
    assert.equal(exactMax.unknown_reason, 'reported_unknown');
    assert.equal(exactMax.error_code, 'INTERNAL');

    const postLf = await processCases.run('res-post-lf-space', () =>
      runProcess(fakeBinary, ['response', 'INTERNAL', 'post-lf'], request, request.kind, PROTOCOL),
    );
    assert.equal(postLf.transport_kind, 'unknown');
    assert.equal(postLf.unknown_reason, 'undecodable_response');

    const unrecognized = await processCases.run('res-valid-zero', () =>
      runProcess(
        fakeBinary,
        ['response', 'FUTURE_OUTCOME_UNKNOWN'],
        request,
        request.kind,
        PROTOCOL,
      ),
    );
    assert.equal(unrecognized.transport_kind, 'correlated_response');
    assert.equal(unrecognized.outcome, 'unknown');
    assert.equal(unrecognized.unknown_reason, 'reported_unknown');
    assert.equal('error_code' in unrecognized, false);

    const nonzero = await processCases.run('res-valid-nonzero', () =>
      runProcess(fakeBinary, ['response', 'INTERNAL', 'nonzero'], request, request.kind, PROTOCOL),
    );
    assert.equal(nonzero.transport_kind, 'unknown');
    assert.equal(nonzero.unknown_reason, 'undecodable_response');

    await assert.rejects(
      runProcess(
        fakeBinary,
        ['stderr', String(MAX_BENCHMARK_STDERR_BYTES + 1)],
        request,
        request.kind,
        PROTOCOL,
      ),
      /benchmark child stderr exceeded 262144 bytes/,
    );
    processCases.complete();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed child timing rejects safely and produces a metadata-only failure manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-malformed-timing-'));
  const outputDir = join(root, 'report');
  try {
    const fakeBinary = join(root, 'malformed-timing-core.cjs');
    writeFileSync(
      fakeBinary,
      `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    protocol: 'aizign',
    version: 1,
    requestId: request.requestId,
    kind: request.kind,
    ok: true,
    payload: { disposition: 'accepted', eventId: request.payload.signal.eventId },
  }) + '\\n');
  process.stderr.write('aizign_timing:{"schema_version":\\n');
});
`,
      { mode: 0o700 },
    );
    chmodSync(fakeBinary, 0o700);
    const request = buildRequest(OUTCOME_CASES[0]);
    let failure;
    await assert.rejects(runProcess(fakeBinary, [], request, request.kind, PROTOCOL), (error) => {
      failure = error;
      return error.errorKind === 'timing_decode_failed';
    });
    writeSmokeFailure(
      {
        binary: fakeBinary,
        outputDir,
        ...PR_SMOKE_CONFIG,
        sweeps: [...PR_SMOKE_CONFIG.sweeps],
      },
      root,
      [],
      {
        phase: 'transport',
        case_name: 'accepted_0',
        sample_phase: 'warm_repeated',
        sample_index: 0,
      },
      failure,
    );
    const statusText = readFileSync(join(outputDir, 'status.json'), 'utf8');
    const status = JSON.parse(statusText);
    assert.equal(status.failure.error_kind, 'timing_decode_failed');
    assert.doesNotMatch(statusText, /aizign_timing|malformed-timing-core|private/);
    assert.match(readFileSync(join(outputDir, 'summary.md'), 'utf8'), /No performance PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release binary hello timeout is bounded and writes a safe setup failure manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-release-timeout-'));
  const outputDir = join(root, 'report');
  try {
    const fakeBinary = join(root, 'hanging-core.cjs');
    writeFileSync(fakeBinary, '#!/usr/bin/env node\nsetInterval(() => undefined, 1_000);\n', {
      mode: 0o700,
    });
    chmodSync(fakeBinary, 0o700);
    const started = Date.now();
    await assert.rejects(
      main(
        [
          '--binary',
          fakeBinary,
          '--profile',
          'pr-smoke',
          '--output-dir',
          outputDir,
          '--sweeps',
          'transport,concurrency,scenarios',
        ],
        { releaseBinaryTimeoutMs: 50 },
      ),
      (error) => error.errorKind === 'release_binary_hello_timeout',
    );
    assert.ok(Date.now() - started < 2_000);
    const statusText = readFileSync(join(outputDir, 'status.json'), 'utf8');
    const status = JSON.parse(statusText);
    assert.equal(status.failure.phase, 'release-binary-verification');
    assert.equal(status.failure.case_name, 'hello');
    assert.equal(status.failure.error_kind, 'release_binary_hello_timeout');
    assert.doesNotMatch(statusText, /hanging-core|aizign-release-timeout/);
    assert.match(readFileSync(join(outputDir, 'summary.md'), 'utf8'), /No performance PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release binary capability mismatch uses the same safe failure manifest path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-release-capability-'));
  const outputDir = join(root, 'report');
  try {
    const fakeBinary = join(root, 'incomplete-core.cjs');
    writeFileSync(
      fakeBinary,
      `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
const request = JSON.parse(input);
process.stdout.write(JSON.stringify({
  protocol: 'aizign',
  version: 1,
  requestId: request.requestId,
  kind: 'hello',
  ok: true,
  payload: {
    protocolVersion: 1,
    journalSchemaVersion: 1,
    capabilities: ['workflow.signal.submit'],
    package: { name: 'aizign', version: '0.1.0' },
  },
}) + '\\n');
});
`,
      { mode: 0o700 },
    );
    chmodSync(fakeBinary, 0o700);
    await assert.rejects(
      main([
        '--binary',
        fakeBinary,
        '--profile',
        'pr-smoke',
        '--output-dir',
        outputDir,
        '--sweeps',
        'transport,concurrency,scenarios',
      ]),
      (error) => error.errorKind === 'release_binary_capability_mismatch',
    );
    const statusText = readFileSync(join(outputDir, 'status.json'), 'utf8');
    const status = JSON.parse(statusText);
    assert.equal(status.failure.phase, 'release-binary-verification');
    assert.equal(status.failure.error_kind, 'release_binary_capability_mismatch');
    assert.doesNotMatch(statusText, /incomplete-core|aizign-release-capability/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(watchdog.statistic, 'p99');
  assert.equal(watchdog.slowest_handler_ms, 30);
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

test('PR smoke summary reports median and max without a p99 claim', () => {
  const fixture = canonicalSmokeFixture();
  const summary = renderSummary({
    metadata: {
      generated_at: '2026-08-25T00:00:00.000Z',
      commit_sha: 'abc',
      working_tree_dirty: false,
      os: 'linux',
      arch: 'x64',
      cpu_model: 'test cpu',
      filesystem: 'ext2/ext3',
      github_runner_image: 'ubuntu24',
      github_runner_image_version: 'test',
      rust_version: 'rustc test',
      node_version: 'v24',
      runner_version: 4,
    },
    config: fixture.config,
    watchdog: compareWatchdog(fixture.aggregates, 10_000, 'max'),
    aggregates: fixture.aggregates,
  });
  assert.match(summary, /slowest warm handler max/);
  assert.match(summary, /median \/ max/);
  assert.doesNotMatch(summary, /p50 \/ p95 \/ p99/);
  assert.doesNotMatch(summary, /handler p99/);
});

test('scenario aggregation keeps preflight, submit, and reconciliation distributions separate', () => {
  const samples = [10, 20].map((base, index) => ({
    sweep: 'scenarios',
    case_name: 'assignment_unknown_reconcile',
    sample_phase: 'warm_repeated',
    sample_index: index,
    aizign_end_to_end_ms: base * 10,
    parent_timings: [
      { operation_kind: 'hello', spawn_to_exit_ms: base - 1, outcome: 'ok' },
      { operation_kind: 'preflight', preflight_ms: base, outcome: 'ok' },
      {
        operation_kind: 'workflow.signal.submit',
        spawn_to_exit_ms: base + 20,
        outcome: 'unknown',
        unknown_reason: 'no_response',
      },
      {
        operation_kind: 'workflow.signal.reconcile',
        spawn_to_exit_ms: base + 40,
        outcome: 'accepted',
      },
    ],
    operations: [
      {
        name: 'submit_lost_ack',
        outcome: 'unknown',
        unknown_reason: 'no_response',
        parent: {
          operation_kind: 'workflow.signal.submit',
          spawn_to_exit_ms: base + 20,
          outcome: 'unknown',
          unknown_reason: 'no_response',
        },
      },
      {
        name: 'lookup',
        outcome: 'accepted',
        parent: {
          operation_kind: 'workflow.signal.reconcile',
          spawn_to_exit_ms: base + 40,
          outcome: 'accepted',
        },
      },
    ],
  }));
  const aggregates = aggregateSamples(samples);
  const scenario = aggregates.find((entry) => entry.sweep === 'scenarios');
  const hello = aggregates.find((entry) => entry.operation_name === 'hello');
  const preflight = aggregates.find((entry) => entry.operation_name === 'preflight');
  const submit = aggregates.find((entry) => entry.operation_name === 'submit_lost_ack');
  const lookup = aggregates.find((entry) => entry.operation_name === 'lookup');
  assert.equal(scenario.metrics.aizign_end_to_end_ms.sample_count, 2);
  assert.equal(scenario.metrics.spawn_to_exit_ms, undefined);
  assert.equal(hello.metrics.spawn_to_exit_ms.p50, 9);
  assert.equal(preflight.metrics.preflight_ms.p50, 10);
  assert.equal(submit.metrics.spawn_to_exit_ms.p50, 30);
  assert.equal(lookup.metrics.spawn_to_exit_ms.p50, 50);
  assert.deepEqual(submit.outcomes, { unknown: 2 });
  assert.deepEqual(lookup.outcomes, { accepted: 2 });
  const summary = renderAggregates(aggregates);
  assert.match(summary, /Canonical scenario operations/);
  assert.match(summary, /assignment_unknown_reconcile \| submit_lost_ack/);
  assert.match(summary, /assignment_unknown_reconcile \| lookup/);
});

test('lost-ACK scenario proxies only submit and verifies its counter outside e2e timing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-scenario-routing-'));
  const instances = [];
  const events = [];
  class FakeOneShotCoreClient {
    constructor(config) {
      this.config = config;
      this.route = config.command.includes('lost-ack-bin') ? 'proxy' : 'direct';
      instances.push(this);
    }

    async hello() {
      events.push(`hello:${this.route}`);
      this.config.timingSink({
        operation_kind: 'hello',
        spawn_to_exit_ms: 1,
        outcome: 'ok',
      });
      return { kind: 'ok', info: {} };
    }

    async submitWorkflowSignal(_requestId, payload) {
      events.push(`submit:${this.route}`);
      if (this.route === 'proxy') {
        this.config.timingSink({
          operation_kind: 'workflow.signal.submit',
          spawn_to_exit_ms: 2,
          outcome: 'unknown',
          unknown_reason: 'no_response',
        });
        return { kind: 'unknown', reason: 'no_response', detail: 'injected' };
      }
      return { kind: 'accepted', eventId: payload.signal.eventId };
    }

    async reconcileWorkflowSignal(_requestId, payload) {
      events.push(`lookup:${this.route}`);
      this.config.timingSink({
        operation_kind: 'workflow.signal.reconcile',
        spawn_to_exit_ms: 3,
        outcome: 'accepted',
      });
      return { kind: 'accepted', eventId: payload.signal.eventId };
    }
  }
  let stateSequence = 0;
  let clock = 100;
  try {
    const sample = await executeScenario(
      {
        config: { binary: '/fake/aizign' },
        nextState: (label) => join(root, `${++stateSequence}-${label}`),
        dependencies: {
          OneShotCoreClient: FakeOneShotCoreClient,
          preflight: async (client, options) => {
            await client.hello();
            options.timingSink({ operation_kind: 'preflight', preflight_ms: 4, outcome: 'ok' });
          },
          now: () => {
            events.push(`clock:${clock}`);
            const current = clock;
            clock += 50;
            return current;
          },
          assertLostAckInvocationCounts: (counterPath) => {
            events.push('assert-counter');
            assert.match(counterPath, /invocations\.txt$/);
          },
        },
      },
      'assignment_unknown_reconcile',
      'warm_repeated',
      0,
    );
    assert.equal(instances.length, 2);
    assert.equal(instances[0].route, 'direct');
    assert.equal(instances[1].route, 'proxy');
    assert.equal(instances[0].config.stateDir, instances[1].config.stateDir);
    assert.deepEqual(events, [
      'clock:100',
      'hello:direct',
      'submit:proxy',
      'lookup:direct',
      'clock:150',
      'assert-counter',
    ]);
    assert.equal(sample.aizign_end_to_end_ms, 50);
    assert.deepEqual(
      sample.operations.map((operation) => [operation.name, operation.parent.operation_kind]),
      [
        ['submit_lost_ack', 'workflow.signal.submit'],
        ['lookup', 'workflow.signal.reconcile'],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical scenarios require the exact timing sequence and semantics', () => {
  const valid = [
    { operation_kind: 'hello', outcome: 'ok' },
    { operation_kind: 'preflight', outcome: 'ok' },
    { operation_kind: 'workflow.signal.submit', outcome: 'accepted' },
  ];
  assert.doesNotThrow(() => assertScenarioTimingSequence('assignment_submit', valid));
  assert.throws(
    () =>
      assertScenarioTimingSequence('assignment_submit', [valid[0], valid[0], ...valid.slice(1)]),
    /not canonical/,
  );
  assert.throws(
    () =>
      assertScenarioTimingSequence('assignment_unknown_reconcile', [
        valid[0],
        valid[1],
        { operation_kind: 'workflow.signal.submit', outcome: 'unknown' },
        { operation_kind: 'workflow.signal.reconcile', outcome: 'accepted' },
      ]),
    /not canonical/,
  );
  assert.throws(
    () => assertScenarioTimingSequence('unregistered_scenario', valid),
    /not canonical/,
  );
});

test('runner arguments keep sweeps independent', () => {
  const parsed = parseArgs([
    '--binary',
    '/tmp/aizign',
    '--profile',
    'pr-smoke',
    '--warmup',
    '0',
    '--samples',
    '2',
    '--sweeps',
    'outcomes,max-payload,scenarios',
  ]);
  assert.equal(parsed.warmup, 0);
  assert.equal(parsed.samples, 2);
  assert.equal(parsed.profile, 'pr-smoke');
  assert.deepEqual(parsed.sweeps, ['outcomes', 'max-payload', 'scenarios']);
});

test('PR smoke budgets require the exact config, matrix, IDs, and three raw metrics', () => {
  const fixture = canonicalSmokeFixture();
  const passing = evaluatePrSmokeBudgets(fixture);
  assert.equal(passing.status, 'pass');
  assert.equal(passing.evaluations.length, 33);
  assert.equal(passing.evaluations[0].sample_count, 3);
  assert.equal(passing.evaluations[0].sample_attribution.sample_index, 2);
  assert.equal(passing.evaluations[0].sample_attribution.stages_ms.append_sync_ms, 4);
  assert.equal(passing.evaluations[0].sample_attribution.stages_us.decide_us, 2.531);
  const renderedStages = renderStageAttribution(passing.evaluations[0].sample_attribution);
  assert.match(renderedStages, /append_sync_ms=4\.000 ms/);
  assert.match(renderedStages, /decide_us=2\.531 µs/);
  assert.doesNotMatch(renderedStages, /decide_us=.* ms/);
  assert.equal(new Set(PR_SMOKE_BUDGET_IDS).size, 33);
  assert.equal(new Set(PR_SMOKE_AGGREGATE_IDENTITIES).size, 23);
  assert.deepEqual(PR_SMOKE_BUDGET_IDS, [
    'transport/accepted_0/handler',
    'transport/accepted_0/spawn',
    'transport/accepted_100/handler',
    'transport/accepted_100/spawn',
    'transport/accepted_9999/handler',
    'transport/accepted_9999/spawn',
    'transport/duplicate_1/handler',
    'transport/duplicate_1/spawn',
    'transport/duplicate_100/handler',
    'transport/duplicate_100/spawn',
    'transport/duplicate_10000/handler',
    'transport/duplicate_10000/spawn',
    'transport/bound_exceeded_10000/handler',
    'transport/bound_exceeded_10000/spawn',
    'transport/lookup_absent_0/handler',
    'transport/lookup_absent_0/spawn',
    'transport/lookup_absent_100/handler',
    'transport/lookup_absent_100/spawn',
    'transport/lookup_absent_10000/handler',
    'transport/lookup_absent_10000/spawn',
    'scenario/assignment_submit/e2e',
    'scenario/assignment_unknown_reconcile/e2e',
    'scenario/assignment_submit/hello',
    'scenario/assignment_submit/preflight',
    'scenario/assignment_submit/submit',
    'scenario/assignment_unknown_reconcile/hello',
    'scenario/assignment_unknown_reconcile/preflight',
    'scenario/assignment_unknown_reconcile/submit_lost_ack',
    'scenario/assignment_unknown_reconcile/lookup',
    'concurrency/submit_same_state_dir_1/batch',
    'concurrency/submit_same_state_dir_2/batch',
    'concurrency/submit_different_state_dir_1/batch',
    'concurrency/submit_different_state_dir_2/batch',
  ]);

  const noncanonical = evaluatePrSmokeBudgets({
    ...fixture,
    config: { ...fixture.config, samples: 1 },
  });
  assert.equal(noncanonical.status, 'fail');
  assert.deepEqual(noncanonical.contract_errors, ['noncanonical_config']);

  const partial = structuredClone(fixture);
  delete partial.samples.find(
    (sample) =>
      sample.sweep === 'transport' &&
      sample.case_name === 'accepted_0' &&
      sample.sample_index === 1,
  ).parent.spawn_to_exit_ms;
  const partialResult = evaluatePrSmokeBudgets({
    ...partial,
    aggregates: aggregateSamples(partial.samples),
  });
  const partialSpawn = partialResult.evaluations.find(
    ({ id }) => id === 'transport/accepted_0/spawn',
  );
  assert.equal(partialSpawn.status, 'fail');
  assert.deepEqual(partialSpawn.contract_errors, [
    'metric_sample_count',
    'raw_metric_sample_count',
  ]);

  const duplicateAggregate = evaluatePrSmokeBudgets({
    ...fixture,
    aggregates: [...fixture.aggregates, fixture.aggregates[0]],
  });
  assert.equal(duplicateAggregate.status, 'fail');
  assert.deepEqual(duplicateAggregate.contract_errors, [
    'duplicate_aggregate',
    'aggregate_identity_mismatch',
  ]);
});

test('native baseline manifest pins sources and the corrected maximum hello p95', () => {
  assert.equal(NATIVE_BASELINE_MANIFEST.runs.length, 3);
  assert.equal(
    NATIVE_BASELINE_MANIFEST.highest_p95_ms.scenario_operations['assignment_submit/hello'],
    3.101074,
  );
  for (const run of NATIVE_BASELINE_MANIFEST.runs) {
    assert.match(run.result_sha256, /^[a-f0-9]{64}$/);
    assert.match(run.summary_sha256, /^[a-f0-9]{64}$/);
  }
  const helloBudget = PR_SMOKE_BUDGETS.find(({ id }) => id === 'scenario/assignment_submit/hello');
  assert.equal(helloBudget.baseline_p95_ms, 3.101074);
});

test('runtime failure writes a metadata-only status and summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-smoke-failure-'));
  const outputDir = join(root, 'report');
  try {
    writeSmokeFailure(
      {
        binary: '/not-recorded/aizign',
        outputDir,
        ...PR_SMOKE_CONFIG,
        sweeps: [...PR_SMOKE_CONFIG.sweeps],
      },
      root,
      [{ sample_phase: 'warm_repeated' }],
      {
        phase: 'transport',
        case_name: 'accepted_9999',
        sample_phase: 'warm_repeated',
        sample_index: 1,
        expected_outcome: 'accepted',
        observed_outcome: 'unknown',
        unknown_reason: 'timeout',
      },
      new Error('private process detail'),
    );
    const status = JSON.parse(readFileSync(join(outputDir, 'status.json'), 'utf8'));
    assert.equal(status.status, 'error');
    assert.equal(status.failure.error_kind, 'runner_error');
    assert.equal(status.failure.unknown_reason, 'timeout');
    assert.equal(status.completed_samples, 1);
    assert.doesNotMatch(JSON.stringify(status), /private process detail|not-recorded/);
    assert.match(readFileSync(join(outputDir, 'summary.md'), 'utf8'), /No performance PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrency prepares every fixture before the common timed execution window', async () => {
  const events = [];
  let clock = 0;
  let stateSequence = 0;
  const context = {
    config: { binary: '/unused' },
    nextState: (label) => `${label}-${++stateSequence}`,
  };
  await executeConcurrencyBatch(
    context,
    'different_state_dir',
    'workflow.signal.submit',
    2,
    'warm_repeated',
    0,
    {
      seedFixture: (stateDir) => events.push(`seed:${stateDir}`),
      now: () => {
        events.push('clock');
        clock += 10;
        return clock;
      },
      runDirectOperation: async (_binary, stateDir) => {
        events.push(`spawn:${stateDir}`);
        return { outcome: 'accepted', parent: {} };
      },
    },
  );
  assert.deepEqual(events, [
    'seed:concurrency-different_state_dir-workflow.signal.submit-1',
    'seed:concurrency-different_state_dir-workflow.signal.submit-2',
    'clock',
    'spawn:concurrency-different_state_dir-workflow.signal.submit-1',
    'spawn:concurrency-different_state_dir-workflow.signal.submit-2',
    'clock',
  ]);
});

test('concurrency rejects semantic failures instead of recording them as a baseline', () => {
  assert.doesNotThrow(() =>
    assertConcurrencySemantics('same_state_dir', 'workflow.signal.submit', [
      { outcome: 'accepted' },
      { outcome: 'rejected', error_code: 'JOURNAL_LOCKED' },
    ]),
  );
  assert.throws(
    () =>
      assertConcurrencySemantics('different_state_dir', 'workflow.signal.submit', [
        { outcome: 'rejected', error_code: 'JOURNAL_UNAVAILABLE' },
      ]),
    /unexpected semantic outcome/,
  );
  assert.throws(
    () =>
      assertConcurrencySemantics('same_state_dir', 'workflow.signal.submit', [
        { outcome: 'rejected', error_code: 'JOURNAL_LOCKED' },
      ]),
    /accept at least one/,
  );
  assert.throws(
    () =>
      assertConcurrencySemantics('same_state_dir', 'workflow.signal.reconcile', [
        { outcome: 'accepted' },
      ]),
    /unexpected semantic outcome/,
  );
  const aggregates = aggregateSamples([
    {
      sweep: 'concurrency',
      case_name: 'submit_same_state_dir_2',
      sample_phase: 'warm_repeated',
      operation_kind: 'workflow.signal.submit',
      mode: 'same_state_dir',
      concurrency: 2,
      journal_entries_before_batch: 100,
      batch_total_ms: 20,
      successful_operations: 1,
      journal_locked: 1,
      unexpected_operations: 0,
      throughput_success_ops_per_s: 50,
      operations: [
        { outcome: 'accepted', parent: {} },
        { outcome: 'rejected', error_code: 'JOURNAL_LOCKED', parent: {} },
      ],
    },
  ]);
  assert.equal(aggregates[0].metrics.throughput_success_ops_per_s.p50, 50);
  assert.equal(aggregates[0].journal_locked, 1);
  const summary = renderAggregates(aggregates, 1);
  assert.match(summary, /Success throughput/);
  assert.match(summary, /accepted:1, rejected:1/);
  assert.match(summary, /JOURNAL_LOCKED:1/);
});

test('lost-ACK proxy drops only a submit response', () => {
  assert.equal(
    requestKind(Buffer.from('{"kind":"workflow.signal.submit"}\n')),
    'workflow.signal.submit',
  );
  assert.equal(dropsAcknowledgement('workflow.signal.submit'), true);
  assert.equal(dropsAcknowledgement('workflow.signal.reconcile'), false);
  assert.match(
    proxyFailureFrame('{"requestId":"req-1","kind":"workflow.signal.submit"}\n'),
    /BENCHMARK_PROXY_OUTPUT_BOUND/,
  );
});

test('lost-ACK proxy preserves the child side effect while suppressing its submit frame', () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-lost-ack-proxy-'));
  try {
    const fakeBinary = join(root, 'fake-core.cjs');
    const durableMarker = join(root, 'durable-marker');
    const counter = join(root, 'invocations.txt');
    writeFileSync(
      fakeBinary,
      `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(durableMarker)}, 'durable');
  process.stdout.write(JSON.stringify({ ok: true, inputBytes: input.length }) + '\\n');
});
`,
      { mode: 0o700 },
    );
    chmodSync(fakeBinary, 0o700);
    const proxy = fileURLToPath(new URL('./lost-ack-proxy.mjs', import.meta.url));
    const run = (kind) =>
      spawnSync(process.execPath, [proxy, fakeBinary, counter, 'handle', '--state', root], {
        encoding: 'utf8',
        env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
        input: `${JSON.stringify({ kind })}\n`,
      });
    const submit = run('workflow.signal.submit');
    assert.equal(submit.status, 0, submit.stderr);
    assert.equal(submit.stdout, '');
    assert.equal(existsSync(durableMarker), true);

    const reconcile = run('workflow.signal.reconcile');
    assert.equal(reconcile.status, 0, reconcile.stderr);
    assert.match(reconcile.stdout, /"ok":true/);
    assert.deepEqual(readFileSync(counter, 'utf8').trim().split('\n'), [
      'workflow.signal.submit',
      'workflow.signal.reconcile',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('benchmark wrappers own timing and lost-ACK controls outside production config', () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-benchmark-wrappers-'));
  try {
    const timing = createTimingExecutable(join(root, 'timing'), '/absolute/aizign');
    const lostAck = createLostAckExecutable(
      join(root, 'lost-ack'),
      '/absolute/aizign',
      join(root, 'counter.txt'),
    );
    const timingSource = readFileSync(timing, 'utf8');
    const lostAckSource = readFileSync(lostAck, 'utf8');
    assert.match(timingSource, /AIZIGN_TIMING_JSON=1/);
    assert.match(timingSource, /\/absolute\/aizign/);
    assert.match(lostAckSource, /lost-ack-proxy\.mjs/);
    assert.match(lostAckSource, /counter\.txt/);
    assert.match(lostAckSource, /\/absolute\/aizign/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lost-ACK proxy bounds child stdout and reports overflow instead of injecting no_response', () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-lost-ack-overflow-'));
  try {
    const fakeBinary = join(root, 'overflow-core.cjs');
    writeFileSync(
      fakeBinary,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(Buffer.alloc(${MAX_FRAME_BYTES + 2}, 120));
});
`,
      { mode: 0o700 },
    );
    chmodSync(fakeBinary, 0o700);
    const proxy = fileURLToPath(new URL('./lost-ack-proxy.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [proxy, fakeBinary, join(root, 'invocations.txt'), 'handle', '--state', root],
      {
        encoding: 'utf8',
        env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
        input: `${JSON.stringify({
          requestId: 'req-overflow',
          kind: 'workflow.signal.submit',
        })}\n`,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    const response = decodeResponse(result.stdout.trim());
    assert.equal(response.requestId, 'req-overflow');
    assert.equal(response.kind, 'workflow.signal.submit');
    assert.equal(response.body.type, 'error');
    assert.equal(response.body.error.code, 'BENCHMARK_PROXY_OUTPUT_BOUND');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact privacy validates timing with an exact key allowlist', () => {
  const result = {
    samples: [
      {
        transport: 'rust_direct',
        transport_kind: 'correlated_response',
        parent: {
          operation_kind: 'workflow.signal.submit',
          spawn_to_exit_ms: 1,
          outcome: 'accepted',
        },
      },
    ],
  };
  assert.doesNotThrow(() => assertArtifactPrivacy(result));
  assert.throws(
    () =>
      assertArtifactPrivacy({
        samples: [{ parent: { ...result.samples[0].parent, eventId: 'evt-secret' } }],
      }),
    /forbidden content key eventId/,
  );
  assert.throws(
    () =>
      assertArtifactPrivacy({
        samples: [{ ...result.samples[0], transport_kind: 'misclassified' }],
      }),
    /unregistered transport_kind/,
  );
  assert.throws(
    () =>
      assertArtifactPrivacy({
        samples: [{ ...result.samples[0], transport_kind: undefined }],
      }),
    /rust_direct transport_kind is missing/,
  );
  for (const spawnToExit of ['arbitrary-content', -1, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        assertArtifactPrivacy({
          samples: [
            {
              parent: {
                operation_kind: 'workflow.signal.submit',
                spawn_to_exit_ms: spawnToExit,
                outcome: 'accepted',
              },
            },
          ],
        }),
      /finite non-negative number/,
    );
  }
  assert.throws(
    () =>
      assertArtifactPrivacy({
        samples: [
          {
            child: {
              schema_version: 2,
              operation_kind: 'workflow.signal.submit',
              journal_entries: 1,
              outcome: 'accepted',
            },
          },
        ],
      }),
    /schema_version must be integer 1/,
  );
  for (const artifact of [
    { samples: [{ sessionId: 'session-sensitive' }] },
    { samples: [{ callId: 'call-sensitive' }] },
    { samples: [{ operations: [{ threadId: 'thread-sensitive' }] }] },
    { samples: [{ parent_timings: [{ turnId: 'turn-sensitive' }] }] },
  ]) {
    assert.throws(() => assertArtifactPrivacy(artifact), /forbidden content key/);
  }
});
