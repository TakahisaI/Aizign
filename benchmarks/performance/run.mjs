#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CANONICAL_SCENARIOS,
  CONCURRENCY_LEVELS,
  CONCURRENCY_MODES,
  CONCURRENCY_OPERATIONS,
  DSH_EVENT_COUNTS,
  JOURNAL_SCALE_CASES,
  MAX_PAYLOAD_CASES,
  OUTCOME_CASES,
  summarizeValues,
  TRANSPORT_CASES,
} from './matrix.mjs';

export const RUNNER_VERSION = 2;
export const CORE_WATCHDOG_MS = 10_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '../..');
const TARGET_EVENT_ID = 'evt-benchmark-target';
const FIXED_EXPECTED = {
  workflowId: 'wf-benchmark',
  assignmentId: 'as-benchmark',
  attemptId: 'attempt-benchmark',
  role: 'implementation',
  artifactRevision: 'rev-benchmark',
  candidateDigest: {
    algorithm: 'sha256',
    hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
};
const nearMaxIdentifier = (prefix) => `${prefix}${'x'.repeat(127)}`;
const NEAR_MAX_EXPECTED = {
  workflowId: nearMaxIdentifier('w'),
  assignmentId: nearMaxIdentifier('a'),
  attemptId: nearMaxIdentifier('t'),
  role: 'implementation',
  artifactRevision: nearMaxIdentifier('r'),
  candidateDigest: {
    algorithm: 'sha256',
    hex: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
};
const NEAR_MAX_EVENT_ID = nearMaxIdentifier('e');
const NEAR_MAX_ARTIFACT_REF = nearMaxIdentifier('f') + 'y'.repeat(128);
const SWEEPS = [
  'journal-scale',
  'outcomes',
  'transport',
  'max-payload',
  'concurrency',
  'dsh',
  'scenarios',
];

let requestSequence = 0;

export function parseArgs(argv) {
  const config = {
    binary: undefined,
    outputDir: join(REPOSITORY_ROOT, 'target', 'performance-baseline'),
    warmup: 3,
    samples: 20,
    sweeps: [...SWEEPS],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === '--binary' && value !== undefined) {
      config.binary = resolve(value);
      index += 1;
    } else if (option === '--output-dir' && value !== undefined) {
      config.outputDir = resolve(value);
      index += 1;
    } else if (option === '--warmup' && value !== undefined) {
      config.warmup = Number.parseInt(value, 10);
      index += 1;
    } else if (option === '--samples' && value !== undefined) {
      config.samples = Number.parseInt(value, 10);
      index += 1;
    } else if (option === '--sweeps' && value !== undefined) {
      config.sweeps = value === 'all' ? [...SWEEPS] : value.split(',').filter(Boolean);
      index += 1;
    } else if (option === '--help' || option === '-h') {
      return { help: true };
    } else {
      throw new Error(`unknown or incomplete option: ${String(option)}`);
    }
  }
  if (config.binary === undefined) throw new Error('--binary is required');
  if (!Number.isInteger(config.warmup) || config.warmup < 0) {
    throw new Error('--warmup must be a non-negative integer');
  }
  if (!Number.isInteger(config.samples) || config.samples < 1) {
    throw new Error('--samples must be a positive integer');
  }
  for (const sweep of config.sweeps) {
    if (!SWEEPS.includes(sweep)) throw new Error(`unknown sweep: ${sweep}`);
  }
  return config;
}

function usage() {
  return `usage: node benchmarks/performance/run.mjs --binary <release-aizign> [options]

options:
  --output-dir <dir>  write result.json and summary.md (default target/performance-baseline)
  --warmup <n>        unrecorded repetitions before warm samples (default 3)
  --samples <n>       warm samples used for p50/p95/p99 (default 20)
  --sweeps <list>     comma-separated journal-scale,outcomes,transport,max-payload,concurrency,dsh,scenarios
`;
}

function nextRequestId() {
  requestSequence += 1;
  return `req-benchmark-${String(requestSequence).padStart(8, '0')}`;
}

export function signal(variant = 'exact', eventId = TARGET_EVENT_ID) {
  if (variant === 'near_max') {
    return {
      ...NEAR_MAX_EXPECTED,
      eventId: eventId === TARGET_EVENT_ID ? NEAR_MAX_EVENT_ID : eventId,
      kind: 'repair_submitted',
      findingCount: 1,
      artifactRef: NEAR_MAX_ARTIFACT_REF,
    };
  }
  const exact = { ...FIXED_EXPECTED, eventId, kind: 'implementation_ready' };
  if (variant === 'changed_signal') {
    return { ...exact, kind: 'blocked', shortErrorCode: 'BENCHMARK_CHANGED' };
  }
  return exact;
}

export function buildRequest(benchmarkCase, eventId = TARGET_EVENT_ID) {
  const requestSignal = signal(benchmarkCase.request_variant, eventId);
  const expected =
    benchmarkCase.request_variant === 'near_max' ? NEAR_MAX_EXPECTED : FIXED_EXPECTED;
  const payload =
    benchmarkCase.operation_kind === 'workflow.signal.submit'
      ? {
          expected:
            benchmarkCase.request_variant === 'expectation_mismatch'
              ? { ...FIXED_EXPECTED, artifactRevision: 'rev-mismatch' }
              : expected,
          signal: requestSignal,
        }
      : { signal: requestSignal };
  return {
    protocol: 'aizign',
    version: 1,
    requestId: nextRequestId(),
    kind: benchmarkCase.operation_kind,
    payload,
  };
}

function journalRecord(seq, eventId, variant = 'exact') {
  return {
    schemaVersion: 1,
    seq,
    at: 1_724_400_000 + (seq % 1_000_000),
    kind: 'workflow.signal.accepted',
    signal: signal(variant, eventId),
  };
}

/** Creates a closed, writer-published fixture without timing fixture generation. */
export function seedFixture(stateDir, entries, fixtureTarget = 'absent', fixtureVariant = 'exact') {
  if (!Number.isInteger(entries) || entries < 0 || entries > 10_000) {
    throw new Error(`fixture entry count out of range: ${entries}`);
  }
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const lines = [];
  for (let seq = 1; seq <= entries; seq += 1) {
    const eventId =
      fixtureTarget === 'exact' && seq === entries
        ? TARGET_EVENT_ID
        : `evt-seed-${String(seq).padStart(5, '0')}`;
    const variant = fixtureTarget === 'exact' && seq === entries ? fixtureVariant : 'exact';
    lines.push(`${JSON.stringify(journalRecord(seq, eventId, variant))}\n`);
  }
  const journal = lines.join('');
  const journalPath = join(stateDir, 'workflow.jsonl');
  const lockPath = join(stateDir, 'workflow.lock');
  const commitPath = join(stateDir, 'workflow.commit.json');
  writeFileSync(lockPath, '', { mode: 0o600, flag: 'wx' });
  writeFileSync(journalPath, journal, { mode: 0o600, flag: 'wx' });
  const commit = {
    storeVersion: 1,
    committedBytes: Buffer.byteLength(journal),
    committedEntries: entries,
    sha256: createHash('sha256').update(journal).digest('hex'),
  };
  writeFileSync(commitPath, JSON.stringify(commit), { mode: 0o600, flag: 'wx' });
  for (const path of [lockPath, journalPath, commitPath]) chmodSync(path, 0o600);
}

export function classifyResponse(response, operationKind) {
  if (response?.ok === true) {
    const outcome = response.payload?.disposition ?? 'ok';
    return { outcome };
  }
  const errorCode = typeof response?.error?.code === 'string' ? response.error.code : undefined;
  if (operationKind === 'workflow.signal.reconcile') {
    return { outcome: 'unknown', error_code: errorCode, unknown_reason: 'reported_unknown' };
  }
  if (errorCode === 'EVENT_CONFLICT') return { outcome: 'conflict', error_code: errorCode };
  if (errorCode === 'JOURNAL_OUTCOME_UNKNOWN' || errorCode === 'HANDLER_TIMEOUT') {
    return { outcome: 'unknown', error_code: errorCode, unknown_reason: 'reported_unknown' };
  }
  return { outcome: 'rejected', error_code: errorCode };
}

function extractChildTiming(stderr) {
  const encoded = stderr
    .split('\n')
    .find((line) => line.startsWith('aizign_timing:'))
    ?.slice('aizign_timing:'.length);
  if (encoded === undefined) return undefined;
  return JSON.parse(encoded);
}

function extractResponse(stdout) {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length !== 1) return undefined;
  try {
    return JSON.parse(lines[0]);
  } catch {
    return undefined;
  }
}

function runProcess(binary, args, frame, operationKind, timingEnabled = true) {
  return new Promise((resolvePromise) => {
    const started = performance.now();
    let responseFirstByteMs;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    try {
      child = spawn(binary, args, {
        env: {
          PATH: process.env.PATH ?? '',
          ...(timingEnabled ? { AIZIGN_TIMING_JSON: '1' } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        outcome: 'unknown',
        unknown_reason: 'spawn_failed',
        parent: {
          operation_kind: operationKind,
          outcome: 'unknown',
          unknown_reason: 'spawn_failed',
        },
        detail: String(error),
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 60_000);
    child.stdout.on('data', (chunk) => {
      responseFirstByteMs ??= performance.now() - started;
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        outcome: 'unknown',
        unknown_reason: 'spawn_failed',
        parent: {
          operation_kind: operationKind,
          outcome: 'unknown',
          unknown_reason: 'spawn_failed',
        },
        detail: error.message,
      });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const spawnToExitMs = performance.now() - started;
      if (timedOut) {
        finish({
          outcome: 'unknown',
          unknown_reason: 'timeout',
          parent: {
            operation_kind: operationKind,
            spawn_to_exit_ms: spawnToExitMs,
            ...(responseFirstByteMs === undefined
              ? {}
              : { response_first_byte_ms: responseFirstByteMs }),
            outcome: 'unknown',
            unknown_reason: 'timeout',
          },
          child: extractChildTiming(stderr),
        });
        return;
      }
      const response = extractResponse(stdout);
      if (response === undefined) {
        finish({
          outcome: 'unknown',
          unknown_reason: 'undecodable_response',
          parent: {
            operation_kind: operationKind,
            spawn_to_exit_ms: spawnToExitMs,
            ...(responseFirstByteMs === undefined
              ? {}
              : { response_first_byte_ms: responseFirstByteMs }),
            outcome: 'unknown',
            unknown_reason: 'undecodable_response',
          },
          child: extractChildTiming(stderr),
        });
        return;
      }
      const classified = classifyResponse(response, operationKind);
      finish({
        ...classified,
        parent: {
          operation_kind: operationKind,
          spawn_to_exit_ms: spawnToExitMs,
          ...(responseFirstByteMs === undefined
            ? {}
            : { response_first_byte_ms: responseFirstByteMs }),
          ...classified,
        },
        child: extractChildTiming(stderr),
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(frame === undefined ? undefined : `${JSON.stringify(frame)}\n`);
  });
}

async function runDirectOperation(binary, stateDir, benchmarkCase, eventId = TARGET_EVENT_ID) {
  const request = buildRequest(benchmarkCase, eventId);
  const result = await runProcess(
    binary,
    ['handle', '--state', stateDir],
    request,
    benchmarkCase.operation_kind,
  );
  if (result.child === undefined && result.unknown_reason === undefined) {
    throw new Error(`${benchmarkCase.name}: child timing was not emitted`);
  }
  return result;
}

async function runReferenceOperation(ReferenceOneShotClient, binary, stateDir, benchmarkCase) {
  const timings = [];
  const client = new ReferenceOneShotClient({
    command: binary,
    env: { AIZIGN_TIMING_JSON: '1' },
    stateDir,
    timeoutMs: 60_000,
    timingSink: (measurement) => timings.push(measurement),
  });
  const request = buildRequest(benchmarkCase);
  const outcome =
    benchmarkCase.operation_kind === 'workflow.signal.submit'
      ? await client.submitWorkflowSignal(request.requestId, request.payload)
      : await client.reconcileWorkflowSignal(request.requestId, request.payload);
  const parent = timings.at(-1);
  if (parent === undefined) throw new Error(`${benchmarkCase.name}: parent timing was not emitted`);
  return {
    outcome: outcome.kind,
    ...('code' in outcome ? { error_code: outcome.code } : {}),
    ...('reportedCode' in outcome && outcome.reportedCode !== undefined
      ? { error_code: outcome.reportedCode }
      : {}),
    ...('reason' in outcome ? { unknown_reason: outcome.reason } : {}),
    parent,
  };
}

function assertExpected(benchmarkCase, result) {
  if (result.outcome !== benchmarkCase.expected_outcome) {
    throw new Error(
      `${benchmarkCase.name}: expected ${benchmarkCase.expected_outcome}, got ${result.outcome}`,
    );
  }
  if (
    benchmarkCase.expected_error_code !== undefined &&
    result.error_code !== benchmarkCase.expected_error_code
  ) {
    throw new Error(
      `${benchmarkCase.name}: expected ${benchmarkCase.expected_error_code}, got ${String(result.error_code)}`,
    );
  }
}

function createContext(config, dependencies, tempRoot) {
  let stateSequence = 0;
  return {
    config,
    dependencies,
    tempRoot,
    nextState(label) {
      stateSequence += 1;
      return join(tempRoot, `${String(stateSequence).padStart(7, '0')}-${label}`);
    },
  };
}

async function executeCase(context, sweep, benchmarkCase, transport, samplePhase, sampleIndex) {
  const stateDir = context.nextState(`${sweep}-${benchmarkCase.name}-${transport}`);
  if (benchmarkCase.fixture_target !== 'missing') {
    seedFixture(
      stateDir,
      benchmarkCase.journal_entries_before_operation,
      benchmarkCase.fixture_target,
      benchmarkCase.fixture_variant,
    );
  }
  const result =
    transport === 'rust_direct'
      ? await runDirectOperation(context.config.binary, stateDir, benchmarkCase)
      : await runReferenceOperation(
          context.dependencies.ReferenceOneShotClient,
          context.config.binary,
          stateDir,
          benchmarkCase,
        );
  assertExpected(benchmarkCase, result);
  return {
    sweep,
    case_name: benchmarkCase.name,
    sample_phase: samplePhase,
    sample_index: sampleIndex,
    process_model: 'new_process_new_open',
    transport,
    operation_kind: benchmarkCase.operation_kind,
    journal_entries_before_operation: benchmarkCase.journal_entries_before_operation,
    outcome: result.outcome,
    ...(result.error_code === undefined ? {} : { error_code: result.error_code }),
    ...(result.unknown_reason === undefined ? {} : { unknown_reason: result.unknown_reason }),
    ...(result.child === undefined ? {} : { child: result.child }),
    parent: result.parent,
  };
}

async function runCaseSeries(context, samples, sweep, benchmarkCase, transport) {
  samples.push(
    await executeCase(context, sweep, benchmarkCase, transport, 'new_process_new_open', 0),
  );
  for (let index = 0; index < context.config.warmup; index += 1) {
    await executeCase(context, sweep, benchmarkCase, transport, 'warmup', index);
  }
  for (let index = 0; index < context.config.samples; index += 1) {
    samples.push(
      await executeCase(context, sweep, benchmarkCase, transport, 'warm_repeated', index),
    );
  }
}

async function runMatrixSweep(context, samples, sweep, cases, transports) {
  for (const benchmarkCase of cases) {
    for (const transport of transports) {
      process.stdout.write(`  ${sweep}: ${benchmarkCase.name} (${transport})\n`);
      await runCaseSeries(context, samples, sweep, benchmarkCase, transport);
    }
  }
}

function concurrencyCase(operationKind, concurrency) {
  return {
    name: `${operationKind === 'workflow.signal.submit' ? 'submit' : 'lookup'}_${concurrency}`,
    operation_kind: operationKind,
    expected_outcome: operationKind === 'workflow.signal.submit' ? 'accepted' : 'absent',
    journal_entries_before_operation: 100,
    fixture_target: 'absent',
  };
}

async function executeConcurrencyBatch(context, mode, operationKind, concurrency, phase, index) {
  const benchmarkCase = concurrencyCase(operationKind, concurrency);
  const sharedState =
    mode === 'same_state_dir'
      ? context.nextState(`concurrency-${mode}-${operationKind}`)
      : undefined;
  if (sharedState !== undefined) seedFixture(sharedState, 100, 'absent');
  const operations = [];
  const started = performance.now();
  for (let operation = 0; operation < concurrency; operation += 1) {
    const stateDir = sharedState ?? context.nextState(`concurrency-${mode}-${operationKind}`);
    if (sharedState === undefined) seedFixture(stateDir, 100, 'absent');
    operations.push(
      runDirectOperation(
        context.config.binary,
        stateDir,
        benchmarkCase,
        `evt-concurrent-${String(index)}-${String(operation)}`,
      ),
    );
  }
  const results = await Promise.all(operations);
  const batchTotalMs = performance.now() - started;
  const successful = results.filter((result) =>
    operationKind === 'workflow.signal.submit'
      ? result.outcome === 'accepted'
      : ['accepted', 'conflict', 'absent'].includes(result.outcome),
  ).length;
  const locked = results.filter((result) => result.error_code === 'JOURNAL_LOCKED').length;
  return {
    sweep: 'concurrency',
    case_name: `${operationKind === 'workflow.signal.submit' ? 'submit' : 'lookup'}_${mode}_${concurrency}`,
    sample_phase: phase,
    sample_index: index,
    process_model: 'new_process_new_open',
    operation_kind: operationKind,
    mode,
    concurrency,
    journal_entries_before_operation: 100,
    batch_total_ms: batchTotalMs,
    successful_operations: successful,
    journal_locked: locked,
    throughput_success_ops_per_s: batchTotalMs === 0 ? 0 : successful / (batchTotalMs / 1_000),
    operations: results.map((result) => ({
      outcome: result.outcome,
      ...(result.error_code === undefined ? {} : { error_code: result.error_code }),
      ...(result.unknown_reason === undefined ? {} : { unknown_reason: result.unknown_reason }),
      ...(result.child === undefined ? {} : { child: result.child }),
      parent: result.parent,
    })),
  };
}

async function runConcurrencySweep(context, samples) {
  for (const operationKind of CONCURRENCY_OPERATIONS) {
    for (const mode of CONCURRENCY_MODES) {
      for (const concurrency of CONCURRENCY_LEVELS) {
        process.stdout.write(`  concurrency: ${operationKind} ${mode} ${concurrency}\n`);
        samples.push(
          await executeConcurrencyBatch(
            context,
            mode,
            operationKind,
            concurrency,
            'new_process_new_open',
            0,
          ),
        );
        for (let index = 0; index < context.config.warmup; index += 1) {
          await executeConcurrencyBatch(context, mode, operationKind, concurrency, 'warmup', index);
        }
        for (let index = 0; index < context.config.samples; index += 1) {
          samples.push(
            await executeConcurrencyBatch(
              context,
              mode,
              operationKind,
              concurrency,
              'warm_repeated',
              index,
            ),
          );
        }
      }
    }
  }
}

function dshEvents(count, dependencies) {
  const args = { kind: 'implementation_ready' };
  const binding = { eventId: TARGET_EVENT_ID, expected: FIXED_EXPECTED };
  const meta = dependencies.presentationMetaFor(binding, args, {
    disposition: 'accepted',
    eventId: TARGET_EVENT_ID,
  });
  const events = [];
  for (let seq = 1; seq <= count - 2; seq += 1) {
    events.push({ type: 'assistant/message', seq, data: {} });
  }
  const callSeq = count - 1;
  events.push({
    type: 'tool/call',
    seq: callSeq,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-benchmark',
      name: 'submit_workflow_signal',
      arguments: JSON.stringify(args),
    },
  });
  events.push({
    type: 'tool/result',
    seq: count,
    data: {
      message: {
        source: { kind: 'tool', callId: 'call-benchmark' },
        content: [],
      },
      meta,
    },
  });
  return { events, binding };
}

async function executeDshColdRead(context, eventCount, phase, index) {
  const { events, binding } = dshEvents(eventCount, context.dependencies);
  const timings = [];
  const evidence = await context.dependencies.readSignalEvidence(
    { readFrom: async () => ({ events }) },
    'session-benchmark',
    binding,
    {
      maxEvents: eventCount,
      timingSink: (measurement) => timings.push(measurement),
    },
  );
  if (evidence.kind !== 'accepted') {
    throw new Error(`dsh_${eventCount}: expected accepted, got ${evidence.kind}`);
  }
  const timing = timings.at(-1);
  if (timing === undefined) throw new Error(`dsh_${eventCount}: timing missing`);
  return {
    sweep: 'dsh',
    case_name: `dsh_cold_read_${eventCount}`,
    sample_phase: phase,
    sample_index: index,
    event_count: eventCount,
    process_model: 'in_process_cold_read',
    outcome: evidence.kind,
    timing,
  };
}

async function runDshSweep(context, samples) {
  for (const count of DSH_EVENT_COUNTS) {
    process.stdout.write(`  dsh: ${count} events\n`);
    samples.push(await executeDshColdRead(context, count, 'new_process_new_open', 0));
    for (let index = 0; index < context.config.warmup; index += 1) {
      await executeDshColdRead(context, count, 'warmup', index);
    }
    for (let index = 0; index < context.config.samples; index += 1) {
      samples.push(await executeDshColdRead(context, count, 'warm_repeated', index));
    }
  }
}

async function executeScenario(context, scenario, phase, index) {
  const stateDir = context.nextState(`scenario-${scenario}`);
  const parentTimings = [];
  const client = new context.dependencies.ReferenceOneShotClient({
    command: context.config.binary,
    stateDir,
    timeoutMs: 60_000,
    timingSink: (measurement) => parentTimings.push(measurement),
  });
  const started = performance.now();
  await context.dependencies.preflight(client, {
    timingSink: (measurement) => parentTimings.push(measurement),
  });
  const operations = [];
  const submitCase = {
    name: `${scenario}_submit`,
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'accepted',
    journal_entries_before_operation: 0,
    fixture_target: 'absent',
  };
  if (scenario === 'assignment_submit') {
    const submitted = await runDirectOperation(context.config.binary, stateDir, submitCase);
    assertExpected(submitCase, submitted);
    operations.push({ name: 'submit', ...submitted });
  } else {
    const submitted = await runDirectOperation(context.config.binary, stateDir, submitCase);
    assertExpected(submitCase, submitted);
    operations.push({
      name: 'submit_injected_unknown',
      ...submitted,
      outcome: 'unknown',
      unknown_reason: 'injected_lost_ack',
      parent: {
        ...submitted.parent,
        outcome: 'unknown',
        unknown_reason: 'injected_lost_ack',
      },
    });
    const lookupCase = {
      name: `${scenario}_lookup`,
      operation_kind: 'workflow.signal.reconcile',
      expected_outcome: 'accepted',
      journal_entries_before_operation: 1,
      fixture_target: 'exact',
    };
    const reconciled = await runDirectOperation(context.config.binary, stateDir, lookupCase);
    assertExpected(lookupCase, reconciled);
    operations.push({ name: 'lookup', ...reconciled });
  }
  return {
    sweep: 'scenarios',
    case_name: scenario,
    sample_phase: phase,
    sample_index: index,
    process_model: 'new_process_new_open',
    aizign_end_to_end_ms: performance.now() - started,
    parent_timings: parentTimings,
    operations: operations.map((operation) => ({
      name: operation.name,
      outcome: operation.outcome,
      ...(operation.error_code === undefined ? {} : { error_code: operation.error_code }),
      ...(operation.unknown_reason === undefined
        ? {}
        : { unknown_reason: operation.unknown_reason }),
      ...(operation.child === undefined ? {} : { child: operation.child }),
      parent: operation.parent,
    })),
  };
}

async function runScenarioSweep(context, samples) {
  for (const scenario of CANONICAL_SCENARIOS) {
    process.stdout.write(`  scenarios: ${scenario}\n`);
    samples.push(await executeScenario(context, scenario, 'new_process_new_open', 0));
    for (let index = 0; index < context.config.warmup; index += 1) {
      await executeScenario(context, scenario, 'warmup', index);
    }
    for (let index = 0; index < context.config.samples; index += 1) {
      samples.push(await executeScenario(context, scenario, 'warm_repeated', index));
    }
  }
}

function increment(counts, value) {
  if (value !== undefined) counts[value] = (counts[value] ?? 0) + 1;
}

function metricSource(sample, name) {
  if (name === 'harness_cold_read_ms') return sample.timing?.harness_cold_read_ms;
  if (name === 'aizign_end_to_end_ms') return sample.aizign_end_to_end_ms;
  if (name === 'batch_total_ms') return sample.batch_total_ms;
  if (name === 'throughput_success_ops_per_s') return sample.throughput_success_ops_per_s;
  return sample.child?.[name] ?? sample.parent?.[name];
}

function pushMetric(values, name, value) {
  if (!Number.isFinite(value)) return;
  if (values[name] === undefined) values[name] = [];
  values[name].push(value);
}

export function aggregateSamples(samples) {
  const groups = new Map();
  for (const sample of samples.filter((candidate) => candidate.sample_phase === 'warm_repeated')) {
    const key = [sample.sweep, sample.case_name, sample.transport ?? '-'].join('\u0000');
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        sweep: sample.sweep,
        case_name: sample.case_name,
        ...(sample.transport === undefined ? {} : { transport: sample.transport }),
        operation_kind: sample.operation_kind,
        journal_entries_before_operation: sample.journal_entries_before_operation,
        ...(sample.mode === undefined ? {} : { mode: sample.mode }),
        ...(sample.concurrency === undefined ? {} : { concurrency: sample.concurrency }),
        ...(sample.event_count === undefined ? {} : { event_count: sample.event_count }),
        outcomes: {},
        error_codes: {},
        unknown_reasons: {},
        values: {},
      };
      groups.set(key, group);
    }
    increment(group.outcomes, sample.outcome);
    increment(group.error_codes, sample.error_code);
    increment(group.unknown_reasons, sample.unknown_reason);
    if (Array.isArray(sample.operations)) {
      for (const operation of sample.operations) {
        increment(group.outcomes, operation.outcome);
        increment(group.error_codes, operation.error_code);
        increment(group.unknown_reasons, operation.unknown_reason);
      }
    }
    for (const metric of [
      'request_read_ms',
      'decode_ms',
      'journal_open_ms',
      'journal_load_decode_ms',
      'committed_prefix_read_ms',
      'committed_prefix_hash_ms',
      'committed_prefix_decode_ms',
      'replay_ms',
      'decide_us',
      'append_sync_ms',
      'publish_prefix_hash_ms',
      'response_encode_ms',
      'response_write_ms',
      'handler_total_ms',
      'spawn_to_exit_ms',
      'response_first_byte_ms',
      'harness_cold_read_ms',
      'aizign_end_to_end_ms',
      'batch_total_ms',
      'throughput_success_ops_per_s',
    ]) {
      const value = metricSource(sample, metric);
      pushMetric(group.values, metric, value);
      if (Array.isArray(sample.operations)) {
        for (const operation of sample.operations) {
          const operationValue = operation.child?.[metric] ?? operation.parent?.[metric];
          pushMetric(group.values, metric, operationValue);
        }
      }
    }
  }
  return [...groups.values()].map(({ values, ...group }) => ({
    ...group,
    metrics: Object.fromEntries(
      Object.entries(values)
        .map(([name, metricValues]) => [name, summarizeValues(metricValues)])
        .filter(([, summary]) => summary !== null),
    ),
  }));
}

function round(value) {
  return value === undefined || value === null ? '-' : value.toFixed(3);
}

function metricTriplet(aggregate, name) {
  const metric = aggregate.metrics[name];
  return metric === undefined
    ? '-'
    : `${round(metric.p50)} / ${round(metric.p95)} / ${round(metric.p99)} (${metric.sample_count})`;
}

export function renderSummary(result) {
  const lines = [
    '# Aizign runtime performance baseline',
    '',
    `Generated: ${result.metadata.generated_at}`,
    '',
    `Commit: \`${result.metadata.commit_sha}\` (working tree dirty: ${String(result.metadata.working_tree_dirty)})`,
    '',
    `Environment: ${result.metadata.os} ${result.metadata.arch}, ${result.metadata.cpu_model}, filesystem ${result.metadata.filesystem}`,
    '',
    `Toolchain: ${result.metadata.rust_version}; ${result.metadata.node_version}; release profile; runner v${result.metadata.runner_version}`,
    '',
    `Sampling: one \`new_process_new_open\` observation, ${result.config.warmup} unrecorded warmups, then ${result.config.samples} \`warm_repeated\` samples per point. Percentiles use nearest rank and always show the sample count.`,
    '',
    'This report is an observation, not a performance budget or CI gate. GitHub-hosted runs do not claim a true cold OS page cache.',
    '',
    `Core watchdog comparison: slowest warm handler p99 ${round(result.watchdog.slowest_handler_p99_ms)} ms in ${result.watchdog.slowest_handler_case}; ${round(result.watchdog.headroom_ms)} ms headroom remains against the ${result.watchdog.core_watchdog_ms} ms default (${round(result.watchdog.headroom_percent)}%).`,
    '',
    '| Sweep | Case | Transport | Entries / events | handler p50 / p95 / p99 ms (n) | spawn p50 / p95 / p99 ms (n) | load p50 / p95 / p99 ms (n) | append p50 / p95 / p99 ms (n) | e2e / DSH / batch p50 / p95 / p99 ms (n) | Outcomes |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const aggregate of result.aggregates) {
    const size =
      aggregate.journal_entries_before_operation ??
      aggregate.event_count ??
      aggregate.concurrency ??
      '-';
    const finalMetric =
      aggregate.metrics.aizign_end_to_end_ms !== undefined
        ? 'aizign_end_to_end_ms'
        : aggregate.metrics.harness_cold_read_ms !== undefined
          ? 'harness_cold_read_ms'
          : 'batch_total_ms';
    lines.push(
      `| ${aggregate.sweep} | ${aggregate.case_name} | ${aggregate.transport ?? '-'} | ${size} | ${metricTriplet(aggregate, 'handler_total_ms')} | ${metricTriplet(aggregate, 'spawn_to_exit_ms')} | ${metricTriplet(aggregate, 'journal_load_decode_ms')} | ${metricTriplet(aggregate, 'append_sync_ms')} | ${metricTriplet(aggregate, finalMetric)} | ${Object.entries(
        aggregate.outcomes,
      )
        .map(([name, count]) => `${name}:${count}`)
        .join(', ')} |`,
    );
  }
  lines.push(
    '',
    '## Committed-prefix attribution',
    '',
    '| Sweep | Case | Entries | read p50 / p95 / p99 ms (n) | verify hash p50 / p95 / p99 ms (n) | decode p50 / p95 / p99 ms (n) | replay p50 / p95 / p99 ms (n) | publish hash p50 / p95 / p99 ms (n) |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const aggregate of result.aggregates.filter(
    (candidate) =>
      candidate.sweep === 'max-payload' ||
      (candidate.sweep === 'journal-scale' &&
        [0, 1_000, 9_999, 10_000].includes(candidate.journal_entries_before_operation)),
  )) {
    lines.push(
      `| ${aggregate.sweep} | ${aggregate.case_name} | ${aggregate.journal_entries_before_operation ?? '-'} | ${metricTriplet(aggregate, 'committed_prefix_read_ms')} | ${metricTriplet(aggregate, 'committed_prefix_hash_ms')} | ${metricTriplet(aggregate, 'committed_prefix_decode_ms')} | ${metricTriplet(aggregate, 'replay_ms')} | ${metricTriplet(aggregate, 'publish_prefix_hash_ms')} |`,
    );
  }
  lines.push(
    '',
    '## Interpretation boundaries',
    '',
    '- `handler_total_ms` is inside `aizign handle`; process spawn is excluded.',
    '- `spawn_to_exit_ms` is observed by the TypeScript/Node parent. `response_first_byte_ms` is response-ready timing because the CLI writes one complete frame, not a stream.',
    '- `journal_entries_before_operation` includes a seeded duplicate/conflict target. Invalid zero-entry duplicate and 10,000-entry accepted fixtures are never generated.',
    '- Same-state contention preserves `JOURNAL_LOCKED`; the runner does not queue or retry. Different-state work uses independent stores.',
    '- DSH evidence cold read is reported as auxiliary harness evidence and is not mixed with journal reconciliation authority.',
    '- `assignment_unknown_reconcile` injects a lost acknowledgement by discarding a completed submit response, then performs one explicit read-only lookup. It never retries submit.',
    '- `max-payload` uses 128-byte identifiers and a 256-byte `artifactRef`; its first observation is the requested release-binary `new_process_new_open` boundary point.',
    '',
  );
  return lines.join('\n');
}

export function compareWatchdog(aggregates, coreWatchdogMs = CORE_WATCHDOG_MS) {
  const candidates = aggregates
    .filter((aggregate) => aggregate.metrics.handler_total_ms !== undefined)
    .map((aggregate) => ({
      case_name: `${aggregate.sweep}/${aggregate.case_name}`,
      p99: aggregate.metrics.handler_total_ms.p99,
    }))
    .sort((left, right) => right.p99 - left.p99);
  const slowest = candidates[0];
  if (slowest === undefined) {
    return {
      core_watchdog_ms: coreWatchdogMs,
      slowest_handler_case: 'unavailable',
      slowest_handler_p99_ms: null,
      headroom_ms: null,
      headroom_percent: null,
    };
  }
  const headroom = coreWatchdogMs - slowest.p99;
  return {
    core_watchdog_ms: coreWatchdogMs,
    slowest_handler_case: slowest.case_name,
    slowest_handler_p99_ms: slowest.p99,
    headroom_ms: headroom,
    headroom_percent: (headroom / coreWatchdogMs) * 100,
  };
}

function capture(programName, args) {
  const result = spawnSync(programName, args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unavailable';
}

function environmentMetadata(tempRoot) {
  const cpu = cpus()[0];
  return {
    generated_at: new Date().toISOString(),
    commit_sha: capture('git', ['rev-parse', 'HEAD']),
    working_tree_dirty: capture('git', ['status', '--short']).length > 0,
    os: `${platform()} ${release()}`,
    arch: process.arch,
    cpu_model: cpu?.model ?? 'unknown',
    cpu_count: cpus().length,
    filesystem: capture('stat', ['-f', '-c', '%T', tempRoot]),
    rust_version: capture('rustc', ['--version']),
    node_version: process.version,
    build_profile: 'release',
    runner_version: RUNNER_VERSION,
  };
}

function verifyReleaseBinary(binary) {
  const hello = spawnSync(binary, ['hello'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  if (hello.status !== 0) throw new Error(`release binary hello failed: ${hello.stderr.trim()}`);
  const response = extractResponse(hello.stdout);
  const capabilities = response?.payload?.capabilities;
  if (
    response?.ok !== true ||
    !Array.isArray(capabilities) ||
    !capabilities.includes('workflow.signal.submit') ||
    !capabilities.includes('workflow.signal.reconcile')
  ) {
    throw new Error(
      'the baseline requires the verified x86_64-unknown-linux-gnu store capabilities',
    );
  }
}

async function loadDependencies() {
  try {
    const testkit = await import(
      pathToFileURL(join(REPOSITORY_ROOT, 'packages/adapter-testkit/lib/index.js')).href
    );
    const dsh = await import(
      pathToFileURL(join(REPOSITORY_ROOT, 'adapters/dsh/lib/index.js')).href
    );
    return {
      ReferenceOneShotClient: testkit.ReferenceOneShotClient,
      preflight: dsh.preflight,
      readSignalEvidence: dsh.readSignalEvidence,
      presentationMetaFor: dsh.presentationMetaFor,
    };
  } catch (error) {
    throw new Error(`TypeScript packages are not built; run npm ci and npm run build (${error})`);
  }
}

function assertArtifactHasNoPrivatePaths(result, forbiddenPaths) {
  const encoded = JSON.stringify(result);
  for (const forbidden of forbiddenPaths) {
    if (forbidden.length > 0 && encoded.includes(forbidden)) {
      throw new Error('performance artifact contains a private filesystem path');
    }
  }
  for (const forbiddenKey of ['requestId', 'stateDir', 'prompt', 'reasoning', 'credential']) {
    if (encoded.includes(`"${forbiddenKey}"`)) {
      throw new Error(`performance artifact contains forbidden content key ${forbiddenKey}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  if (config.help) {
    process.stdout.write(usage());
    return;
  }
  verifyReleaseBinary(config.binary);
  const dependencies = await loadDependencies();
  const tempRoot = mkdtempSync(join(tmpdir(), 'aizign-performance-'));
  const samples = [];
  try {
    const context = createContext(config, dependencies, tempRoot);
    if (config.sweeps.includes('journal-scale')) {
      await runMatrixSweep(context, samples, 'journal-scale', JOURNAL_SCALE_CASES, ['rust_direct']);
    }
    if (config.sweeps.includes('outcomes')) {
      await runMatrixSweep(context, samples, 'outcomes', OUTCOME_CASES, ['rust_direct']);
    }
    if (config.sweeps.includes('transport')) {
      await runMatrixSweep(context, samples, 'transport', TRANSPORT_CASES, [
        'rust_direct',
        'typescript_reference',
      ]);
    }
    if (config.sweeps.includes('max-payload')) {
      await runMatrixSweep(context, samples, 'max-payload', MAX_PAYLOAD_CASES, ['rust_direct']);
    }
    if (config.sweeps.includes('concurrency')) await runConcurrencySweep(context, samples);
    if (config.sweeps.includes('dsh')) await runDshSweep(context, samples);
    if (config.sweeps.includes('scenarios')) await runScenarioSweep(context, samples);

    const aggregates = aggregateSamples(samples);
    const result = {
      schema_version: 2,
      metadata: environmentMetadata(tempRoot),
      config: {
        warmup: config.warmup,
        samples: config.samples,
        sweeps: config.sweeps,
        percentile_method: 'nearest_rank',
        core_watchdog_ms: CORE_WATCHDOG_MS,
      },
      watchdog: compareWatchdog(aggregates),
      aggregates,
      samples,
    };
    assertArtifactHasNoPrivatePaths(result, [REPOSITORY_ROOT, tempRoot, config.binary]);
    mkdirSync(config.outputDir, { recursive: true });
    writeFileSync(join(config.outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(config.outputDir, 'summary.md'), renderSummary(result));
    process.stdout.write(
      `wrote ${result.samples.length} recorded observations and ${result.aggregates.length} aggregate rows\n`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `performance baseline failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
