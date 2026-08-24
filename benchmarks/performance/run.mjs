#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BoundedBuffer } from './bounded-buffer.mjs';
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

export const RUNNER_VERSION = 3;
export const CORE_WATCHDOG_MS = 10_000;
export const MAX_BENCHMARK_STDERR_BYTES = 256 * 1024;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '../..');
const LOST_ACK_PROXY = join(HERE, 'lost-ack-proxy.mjs');
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

const DEFAULT_UNKNOWN_OUTCOME_CODES = new Set([
  'JOURNAL_OUTCOME_UNKNOWN',
  'HANDLER_TIMEOUT',
  'EFFECT_OUTCOME_UNKNOWN',
]);

export function classifyResponse(
  response,
  operationKind,
  isUnknownOutcomeCode = (code) => DEFAULT_UNKNOWN_OUTCOME_CODES.has(code),
) {
  if (response.body.type !== 'error') {
    return { outcome: response.body.type === 'hello' ? 'ok' : response.body.result.disposition };
  }
  const errorCode = response.body.error.code;
  if (operationKind === 'workflow.signal.reconcile') {
    return { outcome: 'unknown', error_code: errorCode, unknown_reason: 'reported_unknown' };
  }
  if (errorCode === 'EVENT_CONFLICT') return { outcome: 'conflict', error_code: errorCode };
  if (isUnknownOutcomeCode(errorCode)) {
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

export function decodeCorrelatedResponse(stdout, request, protocol) {
  if (Buffer.byteLength(stdout) > protocol.MAX_FRAME_BYTES + 1) {
    return { transport_kind: 'unknown', unknown_reason: 'oversized_response' };
  }
  const extraction = protocol.extractFrame(stdout);
  if (extraction.kind === 'empty') {
    return { transport_kind: 'unknown', unknown_reason: 'no_response' };
  }
  if (extraction.kind === 'extra') {
    return { transport_kind: 'unknown', unknown_reason: 'undecodable_response' };
  }
  let response;
  try {
    response = protocol.decodeResponse(extraction.frame);
  } catch {
    return { transport_kind: 'unknown', unknown_reason: 'undecodable_response' };
  }
  const mismatch = protocol.checkCorrelation(
    {
      requestId: request.requestId,
      kind: request.kind,
      eventId: request.payload?.signal?.eventId,
    },
    response,
  );
  if (mismatch !== undefined) {
    const reportedCode = response.body.type === 'error' ? response.body.error.code : undefined;
    return {
      transport_kind: 'unknown',
      unknown_reason: 'correlation_mismatch',
      ...(request.kind === 'workflow.signal.reconcile' && reportedCode !== undefined
        ? { error_code: reportedCode }
        : {}),
    };
  }
  return { transport_kind: 'correlated_response', response };
}

export function runProcess(binary, args, request, operationKind, protocol, timingEnabled = true) {
  return new Promise((resolvePromise) => {
    const started = performance.now();
    let spawnToExitMs;
    let responseFirstByteMs;
    const stdout = new BoundedBuffer(protocol.MAX_FRAME_BYTES + 1);
    const stderr = new BoundedBuffer(MAX_BENCHMARK_STDERR_BYTES);
    let outputOverflow = false;
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
        transport_kind: 'unknown',
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
      if (!stdout.append(chunk) && !outputOverflow) {
        outputOverflow = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      if (!stderr.append(chunk) && !outputOverflow) {
        outputOverflow = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        transport_kind: 'unknown',
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
    child.once('exit', () => {
      spawnToExitMs ??= performance.now() - started;
    });
    child.on('close', () => {
      clearTimeout(timer);
      const transportTiming = {
        ...(spawnToExitMs === undefined ? {} : { spawn_to_exit_ms: spawnToExitMs }),
        ...(responseFirstByteMs === undefined
          ? {}
          : { response_first_byte_ms: responseFirstByteMs }),
      };
      if (outputOverflow) {
        finish({
          transport_kind: 'unknown',
          outcome: 'unknown',
          unknown_reason: 'oversized_response',
          parent: {
            operation_kind: operationKind,
            ...transportTiming,
            outcome: 'unknown',
            unknown_reason: 'oversized_response',
          },
        });
        return;
      }
      if (timedOut) {
        finish({
          transport_kind: 'unknown',
          outcome: 'unknown',
          unknown_reason: 'timeout',
          parent: {
            operation_kind: operationKind,
            ...transportTiming,
            outcome: 'unknown',
            unknown_reason: 'timeout',
          },
          child: extractChildTiming(stderr.toString()),
        });
        return;
      }
      const decoded = decodeCorrelatedResponse(stdout.toString(), request, protocol);
      if (decoded.transport_kind === 'unknown') {
        finish({
          transport_kind: 'unknown',
          outcome: 'unknown',
          ...(decoded.error_code === undefined ? {} : { error_code: decoded.error_code }),
          unknown_reason: decoded.unknown_reason,
          parent: {
            operation_kind: operationKind,
            ...transportTiming,
            outcome: 'unknown',
            ...(decoded.error_code === undefined ? {} : { error_code: decoded.error_code }),
            unknown_reason: decoded.unknown_reason,
          },
          child: extractChildTiming(stderr.toString()),
        });
        return;
      }
      const classified = classifyResponse(
        decoded.response,
        operationKind,
        protocol.isUnknownOutcomeCode,
      );
      finish({
        transport_kind: 'correlated_response',
        ...classified,
        parent: {
          operation_kind: operationKind,
          ...transportTiming,
          ...classified,
        },
        child: extractChildTiming(stderr.toString()),
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(request === undefined ? undefined : `${JSON.stringify(request)}\n`);
  });
}

async function runDirectOperation(
  binary,
  stateDir,
  benchmarkCase,
  eventId = TARGET_EVENT_ID,
  protocol,
) {
  const request = buildRequest(benchmarkCase, eventId);
  const result = await runProcess(
    binary,
    ['handle', '--state', stateDir],
    request,
    benchmarkCase.operation_kind,
    protocol,
  );
  assertDirectTransport(benchmarkCase, result);
  assertDirectChildTiming(benchmarkCase, result);
  return result;
}

export function assertDirectTransport(benchmarkCase, result) {
  const expected = benchmarkCase.expected_transport_kind ?? 'correlated_response';
  if (result.transport_kind !== expected) {
    throw new Error(
      `${benchmarkCase.name}: expected ${expected}, got ${result.transport_kind} (${result.unknown_reason ?? 'no reason'})`,
    );
  }
}

export function assertDirectChildTiming(benchmarkCase, result) {
  if (result.transport_kind === 'correlated_response' && result.child === undefined) {
    throw new Error(`${benchmarkCase.name}: child timing was not emitted`);
  }
}

async function runReferenceOperation(ReferenceOneShotClient, binary, stateDir, benchmarkCase) {
  const timings = [];
  const client = new ReferenceOneShotClient({
    command: binary,
    env: { AIZIGN_TIMING_JSON: '1' },
    stateDir,
    timeoutMs: 60_000,
    timingSink: (measurement) => {
      timings.push(measurement);
    },
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
      ? await runDirectOperation(
          context.config.binary,
          stateDir,
          benchmarkCase,
          TARGET_EVENT_ID,
          context.dependencies.protocol,
        )
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
    ...(result.transport_kind === undefined ? {} : { transport_kind: result.transport_kind }),
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
    fixture_target: 'absent',
  };
}

export function assertConcurrencySemantics(mode, operationKind, results) {
  const isAllowed = (result) => {
    if (operationKind === 'workflow.signal.reconcile') {
      return result.outcome === 'absent' && result.error_code === undefined;
    }
    if (mode === 'different_state_dir') {
      return result.outcome === 'accepted' && result.error_code === undefined;
    }
    return (
      (result.outcome === 'accepted' && result.error_code === undefined) ||
      (result.outcome === 'rejected' && result.error_code === 'JOURNAL_LOCKED')
    );
  };
  const unexpected = results.filter((result) => !isAllowed(result));
  if (unexpected.length > 0) {
    const observed = unexpected
      .map((result) => `${result.outcome}/${result.error_code ?? '-'}`)
      .join(', ');
    throw new Error(
      `concurrency ${operationKind} ${mode}: unexpected semantic outcome(s): ${observed}`,
    );
  }
  if (
    operationKind === 'workflow.signal.submit' &&
    mode === 'same_state_dir' &&
    !results.some((result) => result.outcome === 'accepted')
  ) {
    throw new Error('same-state submit concurrency must accept at least one operation');
  }
}

export async function executeConcurrencyBatch(
  context,
  mode,
  operationKind,
  concurrency,
  phase,
  index,
  hooks = {},
) {
  const benchmarkCase = concurrencyCase(operationKind, concurrency);
  const seed = hooks.seedFixture ?? seedFixture;
  const run = hooks.runDirectOperation ?? runDirectOperation;
  const now = hooks.now ?? (() => performance.now());
  const sharedState =
    mode === 'same_state_dir'
      ? context.nextState(`concurrency-${mode}-${operationKind}`)
      : undefined;
  const stateDirs = Array.from(
    { length: concurrency },
    () => sharedState ?? context.nextState(`concurrency-${mode}-${operationKind}`),
  );
  for (const stateDir of new Set(stateDirs)) seed(stateDir, 100, 'absent');

  const started = now();
  const results = await Promise.all(
    stateDirs.map((stateDir, operation) =>
      run(
        context.config.binary,
        stateDir,
        benchmarkCase,
        `evt-concurrent-${String(index)}-${String(operation)}`,
        context.dependencies?.protocol,
      ),
    ),
  );
  const batchTotalMs = now() - started;
  assertConcurrencySemantics(mode, operationKind, results);
  const successful = results.filter((result) =>
    operationKind === 'workflow.signal.submit'
      ? result.outcome === 'accepted'
      : result.outcome === 'absent',
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
    journal_entries_before_batch: 100,
    batch_total_ms: batchTotalMs,
    successful_operations: successful,
    journal_locked: locked,
    unexpected_operations: 0,
    throughput_success_ops_per_s: batchTotalMs === 0 ? 0 : successful / (batchTotalMs / 1_000),
    operations: results.map((result) => ({
      ...(result.transport_kind === undefined ? {} : { transport_kind: result.transport_kind }),
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

async function executeDshEvidenceRead(context, eventCount, sourceKind, phase, index) {
  const { events, binding } = dshEvents(eventCount, context.dependencies);
  let source;
  if (sourceKind === 'in_memory_scan') {
    source = { readFrom: async () => ({ events }) };
  } else {
    const eventsPath = context.nextState(`dsh-events-${eventCount}-${phase}-${index}.json`);
    writeFileSync(eventsPath, JSON.stringify(events), { mode: 0o600 });
    source = {
      readFrom: async () => ({ events: JSON.parse(await readFile(eventsPath, 'utf8')) }),
    };
  }
  const timings = [];
  const evidence = await context.dependencies.readSignalEvidence(
    source,
    'session-benchmark',
    binding,
    {
      maxEvents: eventCount,
      timingSink: (measurement) => {
        timings.push(measurement);
      },
    },
  );
  if (evidence.kind !== 'accepted') {
    throw new Error(`dsh_${sourceKind}_${eventCount}: expected accepted, got ${evidence.kind}`);
  }
  const timing = timings.at(-1);
  if (timing === undefined) throw new Error(`dsh_${sourceKind}_${eventCount}: timing missing`);
  return {
    sweep: 'dsh',
    case_name: `dsh_evidence_${sourceKind}_${eventCount}`,
    sample_phase: phase,
    sample_index: index,
    event_count: eventCount,
    process_model: sourceKind,
    outcome: evidence.kind,
    timing,
  };
}

async function runDshSweep(context, samples) {
  for (const count of DSH_EVENT_COUNTS) {
    for (const sourceKind of ['in_memory_scan', 'file_backed_read']) {
      process.stdout.write(`  dsh: ${sourceKind} ${count} events\n`);
      samples.push(
        await executeDshEvidenceRead(context, count, sourceKind, 'new_process_new_open', 0),
      );
      for (let index = 0; index < context.config.warmup; index += 1) {
        await executeDshEvidenceRead(context, count, sourceKind, 'warmup', index);
      }
      for (let index = 0; index < context.config.samples; index += 1) {
        samples.push(
          await executeDshEvidenceRead(context, count, sourceKind, 'warm_repeated', index),
        );
      }
    }
  }
}

export function assertLostAckInvocationCounts(counterPath) {
  const invocations = readFileSync(counterPath, 'utf8').trim().split('\n').filter(Boolean);
  if (invocations.length !== 1 || invocations[0] !== 'workflow.signal.submit') {
    throw new Error('lost-ACK scenario must invoke the proxy for submit exactly once');
  }
}

export async function executeScenario(context, scenario, phase, index) {
  const stateDir = context.nextState(`scenario-${scenario}`);
  const counterPath = context.nextState(`scenario-${scenario}-invocations.txt`);
  const parentTimings = [];
  const losesSubmitAcknowledgement = scenario === 'assignment_unknown_reconcile';
  const clientConfig = {
    stateDir,
    timeoutMs: 60_000,
    timingSink: (measurement) => {
      parentTimings.push(measurement);
    },
  };
  const directClient = new context.dependencies.ReferenceOneShotClient({
    ...clientConfig,
    command: context.config.binary,
    env: { AIZIGN_TIMING_JSON: '1' },
  });
  const lostAckClient = losesSubmitAcknowledgement
    ? new context.dependencies.ReferenceOneShotClient({
        ...clientConfig,
        command: process.execPath,
        args: [LOST_ACK_PROXY, context.config.binary],
        env: {
          AIZIGN_LOST_ACK_COUNTER: counterPath,
          AIZIGN_TIMING_JSON: '1',
        },
      })
    : undefined;
  const now = context.dependencies.now ?? (() => performance.now());
  const verifyLostAckInvocations =
    context.dependencies.assertLostAckInvocationCounts ?? assertLostAckInvocationCounts;
  const started = now();
  await context.dependencies.preflight(directClient, {
    timingSink: (measurement) => {
      parentTimings.push(measurement);
    },
  });
  if (parentTimings.at(-1)?.operation_kind !== 'preflight') {
    throw new Error(`${scenario}: preflight timing was not emitted`);
  }
  const operations = [];
  const submitCase = {
    name: `${scenario}_submit`,
    operation_kind: 'workflow.signal.submit',
    expected_outcome: losesSubmitAcknowledgement ? 'unknown' : 'accepted',
    journal_entries_before_operation: 0,
    fixture_target: 'absent',
  };
  const submitRequest = buildRequest(submitCase);
  const submitClient = lostAckClient ?? directClient;
  const submitOutcome = await submitClient.submitWorkflowSignal(
    submitRequest.requestId,
    submitRequest.payload,
  );
  let aizignEndToEndMs = losesSubmitAcknowledgement ? undefined : now() - started;
  const submitted = {
    outcome: submitOutcome.kind,
    ...('code' in submitOutcome ? { error_code: submitOutcome.code } : {}),
    ...('reportedCode' in submitOutcome && submitOutcome.reportedCode !== undefined
      ? { error_code: submitOutcome.reportedCode }
      : {}),
    ...('reason' in submitOutcome ? { unknown_reason: submitOutcome.reason } : {}),
    parent: parentTimings.at(-1),
  };
  if (scenario === 'assignment_submit') {
    assertExpected(submitCase, submitted);
    operations.push({ name: 'submit', ...submitted });
  } else {
    assertExpected(submitCase, submitted);
    if (submitted.unknown_reason !== 'no_response') {
      throw new Error(`lost-ACK submit expected no_response, got ${submitted.unknown_reason}`);
    }
    operations.push({ name: 'submit_lost_ack', ...submitted });
    const lookupCase = {
      name: `${scenario}_lookup`,
      operation_kind: 'workflow.signal.reconcile',
      expected_outcome: 'accepted',
      journal_entries_before_operation: 1,
      fixture_target: 'exact',
    };
    const reconcileOutcome = await directClient.reconcileWorkflowSignal(nextRequestId(), {
      signal: submitRequest.payload.signal,
    });
    aizignEndToEndMs = now() - started;
    const reconciled = {
      outcome: reconcileOutcome.kind,
      ...('reportedCode' in reconcileOutcome && reconcileOutcome.reportedCode !== undefined
        ? { error_code: reconcileOutcome.reportedCode }
        : {}),
      ...('reason' in reconcileOutcome ? { unknown_reason: reconcileOutcome.reason } : {}),
      parent: parentTimings.at(-1),
    };
    assertExpected(lookupCase, reconciled);
    operations.push({ name: 'lookup', ...reconciled });
  }
  if (losesSubmitAcknowledgement) verifyLostAckInvocations(counterPath);
  if (aizignEndToEndMs === undefined) throw new Error(`${scenario}: scenario timing is missing`);
  return {
    sweep: 'scenarios',
    case_name: scenario,
    sample_phase: phase,
    sample_index: index,
    process_model: 'new_process_new_open',
    aizign_end_to_end_ms: aizignEndToEndMs,
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

const AGGREGATE_METRICS = [
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
  'preflight_ms',
  'harness_cold_read_ms',
  'aizign_end_to_end_ms',
  'batch_total_ms',
  'throughput_success_ops_per_s',
];

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
  const getGroup = (key, identity) => {
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        ...identity,
        outcomes: {},
        error_codes: {},
        unknown_reasons: {},
        values: {},
      };
      groups.set(key, group);
    }
    return group;
  };
  const recordMetrics = (group, source) => {
    for (const metric of AGGREGATE_METRICS) {
      pushMetric(group.values, metric, metricSource(source, metric));
    }
  };
  for (const sample of samples.filter((candidate) => candidate.sample_phase === 'warm_repeated')) {
    const key = [sample.sweep, sample.case_name, sample.transport ?? '-'].join('\u0000');
    const group = getGroup(key, {
      sweep: sample.sweep,
      case_name: sample.case_name,
      ...(sample.transport === undefined ? {} : { transport: sample.transport }),
      operation_kind: sample.operation_kind,
      journal_entries_before_operation: sample.journal_entries_before_operation,
      ...(sample.journal_entries_before_batch === undefined
        ? {}
        : { journal_entries_before_batch: sample.journal_entries_before_batch }),
      ...(sample.mode === undefined ? {} : { mode: sample.mode }),
      ...(sample.concurrency === undefined ? {} : { concurrency: sample.concurrency }),
      ...(sample.event_count === undefined ? {} : { event_count: sample.event_count }),
      ...(sample.sweep === 'concurrency'
        ? { successful_operations: 0, journal_locked: 0, unexpected_operations: 0 }
        : {}),
    });
    increment(group.outcomes, sample.outcome);
    increment(group.error_codes, sample.error_code);
    increment(group.unknown_reasons, sample.unknown_reason);
    recordMetrics(group, sample);
    if (sample.sweep === 'concurrency') {
      group.successful_operations += sample.successful_operations;
      group.journal_locked += sample.journal_locked;
      group.unexpected_operations += sample.unexpected_operations;
    }
    if (sample.sweep === 'scenarios') {
      const preflight = sample.parent_timings?.find(
        (measurement) => measurement.operation_kind === 'preflight',
      );
      if (preflight === undefined) {
        throw new Error(`${sample.case_name}: preflight timing is missing from scenario sample`);
      }
      const scenarioMeasurements = [
        { name: 'preflight', parent: preflight },
        ...(sample.operations ?? []),
      ];
      for (const operation of scenarioMeasurements) {
        const operationKey = ['scenario-operations', sample.case_name, operation.name].join(
          '\u0000',
        );
        const operationGroup = getGroup(operationKey, {
          sweep: 'scenario-operations',
          case_name: sample.case_name,
          operation_name: operation.name,
          operation_kind: operation.parent?.operation_kind,
        });
        increment(operationGroup.outcomes, operation.outcome ?? operation.parent?.outcome);
        increment(operationGroup.error_codes, operation.error_code ?? operation.parent?.error_code);
        increment(
          operationGroup.unknown_reasons,
          operation.unknown_reason ?? operation.parent?.unknown_reason,
        );
        recordMetrics(operationGroup, operation);
      }
    } else if (Array.isArray(sample.operations)) {
      for (const operation of sample.operations) {
        increment(group.outcomes, operation.outcome);
        increment(group.error_codes, operation.error_code);
        increment(group.unknown_reasons, operation.unknown_reason);
        recordMetrics(group, operation);
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

function countSummary(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0 ? '-' : entries.map(([name, count]) => `${name}:${count}`).join(', ');
}

export function renderSummary(result) {
  const lines = [
    '# Aizign runtime performance baseline',
    '',
    `Generated: ${result.metadata.generated_at}`,
    '',
    `Commit: \`${result.metadata.commit_sha}\` (working tree dirty: ${String(result.metadata.working_tree_dirty)})`,
    '',
    `Environment: ${result.metadata.os} ${result.metadata.arch}, ${result.metadata.cpu_model}, filesystem ${result.metadata.filesystem}, runner image ${result.metadata.github_runner_image} ${result.metadata.github_runner_image_version}`,
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
  for (const aggregate of result.aggregates.filter(
    (candidate) => !['concurrency', 'scenario-operations'].includes(candidate.sweep),
  )) {
    const size =
      aggregate.journal_entries_before_operation ??
      aggregate.journal_entries_before_batch ??
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
      `| ${aggregate.sweep} | ${aggregate.case_name} | ${aggregate.transport ?? '-'} | ${size} | ${metricTriplet(aggregate, 'handler_total_ms')} | ${metricTriplet(aggregate, 'spawn_to_exit_ms')} | ${metricTriplet(aggregate, 'journal_load_decode_ms')} | ${metricTriplet(aggregate, 'append_sync_ms')} | ${metricTriplet(aggregate, finalMetric)} | ${countSummary(aggregate.outcomes)} |`,
    );
  }
  lines.push(
    '',
    '## Concurrency semantics and throughput',
    '',
    '| Operation | Mode | Concurrency | Entries before batch | Batch p50 / p95 / p99 ms (n) | Success throughput p50 / p95 / p99 ops/s (n) | Accepted | JOURNAL_LOCKED | Unexpected | Outcomes | Error codes |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
  );
  for (const aggregate of result.aggregates.filter(
    (candidate) => candidate.sweep === 'concurrency',
  )) {
    lines.push(
      `| ${aggregate.operation_kind} | ${aggregate.mode} | ${aggregate.concurrency} | ${aggregate.journal_entries_before_batch} | ${metricTriplet(aggregate, 'batch_total_ms')} | ${metricTriplet(aggregate, 'throughput_success_ops_per_s')} | ${aggregate.outcomes.accepted ?? 0} | ${aggregate.journal_locked} | ${aggregate.unexpected_operations} | ${countSummary(aggregate.outcomes)} | ${countSummary(aggregate.error_codes)} |`,
    );
  }
  lines.push(
    '',
    '## Canonical scenario operations',
    '',
    '| Scenario | Operation | Kind | preflight p50 / p95 / p99 ms (n) | spawn p50 / p95 / p99 ms (n) | first byte p50 / p95 / p99 ms (n) | Outcomes | Error codes | Unknown reasons |',
    '|---|---|---|---:|---:|---:|---|---|---|',
  );
  for (const aggregate of result.aggregates.filter(
    (candidate) => candidate.sweep === 'scenario-operations',
  )) {
    lines.push(
      `| ${aggregate.case_name} | ${aggregate.operation_name} | ${aggregate.operation_kind} | ${metricTriplet(aggregate, 'preflight_ms')} | ${metricTriplet(aggregate, 'spawn_to_exit_ms')} | ${metricTriplet(aggregate, 'response_first_byte_ms')} | ${countSummary(aggregate.outcomes)} | ${countSummary(aggregate.error_codes)} | ${countSummary(aggregate.unknown_reasons)} |`,
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
    '- Concurrency uses `journal_entries_before_batch` because same-state submissions can change the journal before later contenders acquire the lock.',
    '- Same-state submit allows only `accepted` or `JOURNAL_LOCKED` and requires at least one acceptance. Different-state submit requires all accepted; reconciliation requires all absent. Any other semantic result aborts the run.',
    '- DSH in-memory scan and deterministic file-backed read are separate auxiliary series and are not mixed with journal reconciliation authority.',
    '- `assignment_unknown_reconcile` uses a direct reference-client instance for preflight and reconciliation, and a second instance through the lost-ACK proxy for submit only. Counter verification runs after the scenario timer closes.',
    '- Scenario-wide `aizign_end_to_end_ms`, whole-preflight `preflight_ms`, submit transport, and reconciliation transport are separate aggregate rows.',
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
    github_runner_image: process.env.ImageOS ?? 'local',
    github_runner_image_version: process.env.ImageVersion ?? 'unavailable',
  };
}

function verifyReleaseBinary(binary, protocol) {
  const hello = spawnSync(binary, ['hello'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  if (hello.status !== 0) throw new Error(`release binary hello failed: ${hello.stderr.trim()}`);
  const extraction = protocol.extractFrame(hello.stdout);
  let response;
  if (extraction.kind === 'frame') {
    try {
      response = protocol.decodeResponse(extraction.frame);
    } catch {
      response = undefined;
    }
  }
  const capabilities =
    response?.body.type === 'hello' ? response.body.info.capabilities : undefined;
  if (
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
    const protocol = await import(
      pathToFileURL(join(REPOSITORY_ROOT, 'packages/protocol/lib/index.js')).href
    );
    const testkit = await import(
      pathToFileURL(join(REPOSITORY_ROOT, 'packages/adapter-testkit/lib/index.js')).href
    );
    const dsh = await import(
      pathToFileURL(join(REPOSITORY_ROOT, 'adapters/dsh/lib/index.js')).href
    );
    return {
      protocol: {
        MAX_FRAME_BYTES: protocol.MAX_FRAME_BYTES,
        checkCorrelation: protocol.checkCorrelation,
        decodeResponse: protocol.decodeResponse,
        extractFrame: protocol.extractFrame,
        isUnknownOutcomeCode: protocol.isUnknownOutcomeCode,
      },
      ReferenceOneShotClient: testkit.ReferenceOneShotClient,
      preflight: dsh.preflight,
      readSignalEvidence: dsh.readSignalEvidence,
      presentationMetaFor: dsh.presentationMetaFor,
    };
  } catch (error) {
    throw new Error(`TypeScript packages are not built; run npm ci and npm run build (${error})`);
  }
}

const CHILD_TIMING_KEYS = new Set([
  'schema_version',
  'request_read_ms',
  'decode_ms',
  'journal_open_ms',
  'journal_physical_bytes',
  'journal_entries',
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
  'outcome',
  'error_code',
  'operation_kind',
]);
const PARENT_TIMING_KEYS = new Set([
  'operation_kind',
  'spawn_to_exit_ms',
  'response_first_byte_ms',
  'preflight_ms',
  'outcome',
  'error_code',
  'unknown_reason',
]);
const DSH_TIMING_KEYS = new Set([
  'operation_kind',
  'harness_cold_read_ms',
  'events_returned',
  'outcome',
  'unknown_reason',
]);
const OPERATION_KINDS = new Set([
  'hello',
  'workflow.signal.submit',
  'workflow.signal.reconcile',
  'preflight',
  'dsh.evidence.cold_read',
  'unknown',
]);
const TIMING_OUTCOMES = new Set([
  'ok',
  'accepted',
  'duplicate',
  'conflict',
  'absent',
  'rejected',
  'error',
  'unknown',
]);
const UNKNOWN_REASONS = new Set([
  'no_response',
  'undecodable_response',
  'oversized_response',
  'correlation_mismatch',
  'timeout',
  'spawn_failed',
  'reported_unknown',
  'aborted',
  'unverified_error',
  'no_result',
  'meta_mismatch',
  'bound_exceeded',
]);
const TRANSPORT_KINDS = new Set(['correlated_response', 'unknown']);
const NON_NEGATIVE_TIMING_FIELDS = new Set([
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
  'preflight_ms',
  'harness_cold_read_ms',
]);
const NON_NEGATIVE_INTEGER_FIELDS = new Set([
  'journal_physical_bytes',
  'journal_entries',
  'events_returned',
]);

function assertTimingShape(measurement, allowedKeys, label) {
  if (typeof measurement !== 'object' || measurement === null || Array.isArray(measurement)) {
    throw new Error(`${label} timing must be an object`);
  }
  for (const key of Object.keys(measurement)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} timing contains unregistered key ${key}`);
  }
  if (!OPERATION_KINDS.has(measurement.operation_kind)) {
    throw new Error(`${label} timing contains unregistered operation_kind`);
  }
  if (!TIMING_OUTCOMES.has(measurement.outcome)) {
    throw new Error(`${label} timing contains unregistered outcome`);
  }
  if (allowedKeys.has('schema_version') && measurement.schema_version !== 1) {
    throw new Error(`${label} timing schema_version must be integer 1`);
  }
  for (const key of NON_NEGATIVE_TIMING_FIELDS) {
    if (
      measurement[key] !== undefined &&
      (!Number.isFinite(measurement[key]) || measurement[key] < 0)
    ) {
      throw new Error(`${label} timing ${key} must be a finite non-negative number`);
    }
  }
  for (const key of NON_NEGATIVE_INTEGER_FIELDS) {
    if (
      measurement[key] !== undefined &&
      (!Number.isSafeInteger(measurement[key]) || measurement[key] < 0)
    ) {
      throw new Error(`${label} timing ${key} must be a non-negative safe integer`);
    }
  }
  if (
    measurement.error_code !== undefined &&
    (typeof measurement.error_code !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(measurement.error_code))
  ) {
    throw new Error(`${label} timing contains an invalid error_code`);
  }
  if (
    measurement.unknown_reason !== undefined &&
    !UNKNOWN_REASONS.has(measurement.unknown_reason)
  ) {
    throw new Error(`${label} timing contains an unregistered unknown_reason`);
  }
}

function assertTransportKind(value, label) {
  if (!TRANSPORT_KINDS.has(value)) {
    throw new Error(`${label} contains an unregistered transport_kind`);
  }
}

export function assertArtifactPrivacy(result, forbiddenPaths = []) {
  for (const [sampleIndex, sample] of (result.samples ?? []).entries()) {
    if (sample.transport === 'rust_direct' && sample.transport_kind === undefined) {
      throw new Error(`samples[${sampleIndex}] rust_direct transport_kind is missing`);
    }
    if (sample.transport_kind !== undefined) {
      assertTransportKind(sample.transport_kind, `samples[${sampleIndex}]`);
    }
    if (sample.child !== undefined) {
      assertTimingShape(sample.child, CHILD_TIMING_KEYS, `samples[${sampleIndex}].child`);
    }
    if (sample.parent !== undefined) {
      assertTimingShape(sample.parent, PARENT_TIMING_KEYS, `samples[${sampleIndex}].parent`);
    }
    if (sample.timing !== undefined) {
      assertTimingShape(sample.timing, DSH_TIMING_KEYS, `samples[${sampleIndex}].timing`);
    }
    for (const [timingIndex, timing] of (sample.parent_timings ?? []).entries()) {
      assertTimingShape(
        timing,
        PARENT_TIMING_KEYS,
        `samples[${sampleIndex}].parent_timings[${timingIndex}]`,
      );
    }
    for (const [operationIndex, operation] of (sample.operations ?? []).entries()) {
      if (sample.sweep === 'concurrency' && operation.transport_kind === undefined) {
        throw new Error(
          `samples[${sampleIndex}].operations[${operationIndex}] transport_kind is missing`,
        );
      }
      if (operation.transport_kind !== undefined) {
        assertTransportKind(
          operation.transport_kind,
          `samples[${sampleIndex}].operations[${operationIndex}]`,
        );
      }
      if (operation.child !== undefined) {
        assertTimingShape(
          operation.child,
          CHILD_TIMING_KEYS,
          `samples[${sampleIndex}].operations[${operationIndex}].child`,
        );
      }
      if (operation.parent !== undefined) {
        assertTimingShape(
          operation.parent,
          PARENT_TIMING_KEYS,
          `samples[${sampleIndex}].operations[${operationIndex}].parent`,
        );
      }
    }
  }
  const encoded = JSON.stringify(result);
  for (const forbidden of forbiddenPaths) {
    if (forbidden.length > 0 && encoded.includes(forbidden)) {
      throw new Error('performance artifact contains a private filesystem path');
    }
  }
  for (const forbiddenKey of [
    'requestId',
    'eventId',
    'workflowId',
    'assignmentId',
    'attemptId',
    'artifactRevision',
    'artifactRef',
    'candidateDigest',
    'stateDir',
    'prompt',
    'reasoning',
    'credential',
  ]) {
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
  const dependencies = await loadDependencies();
  verifyReleaseBinary(config.binary, dependencies.protocol);
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
      schema_version: 3,
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
    assertArtifactPrivacy(result, [REPOSITORY_ROOT, tempRoot, config.binary]);
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
