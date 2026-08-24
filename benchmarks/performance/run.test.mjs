// These tests validate fixtures and aggregation without requiring Linux storage support.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
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
import {
  checkCorrelation,
  decodeResponse,
  extractFrame,
  isUnknownOutcomeCode,
  MAX_FRAME_BYTES,
} from '../../packages/protocol/lib/index.js';
import { BoundedBuffer } from './bounded-buffer.mjs';
import { dropsAcknowledgement, proxyFailureFrame, requestKind } from './lost-ack-proxy.mjs';
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
  assertArtifactPrivacy,
  assertConcurrencySemantics,
  assertDirectChildTiming,
  assertDirectTransport,
  assertLostAckInvocationCounts,
  buildRequest,
  classifyResponse,
  compareWatchdog,
  decodeCorrelatedResponse,
  executeConcurrencyBatch,
  executeScenario,
  MAX_BENCHMARK_STDERR_BYTES,
  parseArgs,
  renderSummary,
  runProcess,
  seedFixture,
} from './run.mjs';

const PROTOCOL = {
  checkCorrelation,
  decodeResponse,
  extractFrame,
  isUnknownOutcomeCode,
  MAX_FRAME_BYTES,
};

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
    classifyResponse(
      { body: { type: 'error', error: { code: 'EVENT_CONFLICT' } } },
      'workflow.signal.submit',
    ),
    { outcome: 'conflict', error_code: 'EVENT_CONFLICT' },
  );
  assert.deepEqual(
    classifyResponse(
      { body: { type: 'error', error: { code: 'JOURNAL_LOCKED' } } },
      'workflow.signal.reconcile',
    ),
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

test('direct runner classifies stdout overflow and fails on stderr overflow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-direct-output-bound-'));
  try {
    const fakeBinary = join(root, 'overflow-core.cjs');
    writeFileSync(
      fakeBinary,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const stream = process.argv[2] === 'stderr' ? process.stderr : process.stdout;
  stream.write(Buffer.alloc(Number(process.argv[3]), 120));
});
`,
      { mode: 0o700 },
    );
    chmodSync(fakeBinary, 0o700);
    const request = buildRequest(OUTCOME_CASES[0]);
    const stdoutResult = await runProcess(
      fakeBinary,
      ['stdout', String(MAX_FRAME_BYTES + 2)],
      request,
      request.kind,
      PROTOCOL,
    );
    assert.equal(stdoutResult.transport_kind, 'unknown');
    assert.equal(stdoutResult.unknown_reason, 'oversized_response');

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
  const preflight = aggregates.find((entry) => entry.operation_name === 'preflight');
  const submit = aggregates.find((entry) => entry.operation_name === 'submit_lost_ack');
  const lookup = aggregates.find((entry) => entry.operation_name === 'lookup');
  assert.equal(scenario.metrics.aizign_end_to_end_ms.sample_count, 2);
  assert.equal(scenario.metrics.spawn_to_exit_ms, undefined);
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
  class FakeReferenceOneShotClient {
    constructor(config) {
      this.config = config;
      this.route = config.command === process.execPath ? 'proxy' : 'direct';
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
        appendFileSync(this.config.env.AIZIGN_LOST_ACK_COUNTER, 'workflow.signal.submit\n', {
          mode: 0o600,
        });
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
          ReferenceOneShotClient: FakeReferenceOneShotClient,
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
            assertLostAckInvocationCounts(counterPath);
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
  assert.equal(requestKind(['hello'], ''), 'hello');
  assert.equal(
    requestKind(['handle', '--state', '/private'], '{"kind":"workflow.signal.submit"}\n'),
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
      spawnSync(process.execPath, [proxy, fakeBinary, 'handle', '--state', root], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', AIZIGN_LOST_ACK_COUNTER: counter },
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
    const result = spawnSync(process.execPath, [proxy, fakeBinary, 'handle', '--state', root], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      input: `${JSON.stringify({
        requestId: 'req-overflow',
        kind: 'workflow.signal.submit',
      })}\n`,
    });
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
  assert.throws(
    () =>
      assertArtifactPrivacy({
        samples: [
          {
            timing: {
              operation_kind: 'dsh.evidence.cold_read',
              harness_cold_read_ms: 1,
              events_returned: 1.5,
              outcome: 'accepted',
            },
          },
        ],
      }),
    /non-negative safe integer/,
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
