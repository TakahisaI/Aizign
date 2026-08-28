/**
 * This adapter's core client against the fake core (every unknown path) and,
 * when `AIZIGN_BINARY` is set, against the real binary.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fakeCoreExecutable,
  runCoreClientConformance,
  runCoreScenarios,
  samplePayload,
} from '@aizign/adapter-testkit';
import { codes, ProtocolError } from '@aizign/protocol';
import { createProcessProfileRegistry } from '../../../../spec/process/v1/fixtures/registry.mjs';
import { OneShotCoreClient } from '../../src/core-client/one-shot-client.ts';
import type { ParentTimingMeasurement } from '../../src/timing.ts';

test('OneShotCoreClient executes every assigned process-profile case', async () => {
  const registry = createProcessProfileRegistry('dsh');
  await runCoreClientConformance((config) => new OneShotCoreClient(config), {
    caseExecuted: registry.record,
  });
  registry.complete();
});

test('local encoder failures have zero transport and parent-timing side effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-local-encode-'));
  try {
    const invocationLog = join(root, 'invocations.log');
    const stateDir = join(root, 'state');
    const measurements: ParentTimingMeasurement[] = [];
    const client = new OneShotCoreClient({
      command: fakeCoreExecutable(join(root, 'bin'), { invocationLog }),
      stateDir,
      timeoutMs: 5_000,
      timingSink: (measurement) => {
        measurements.push(measurement);
      },
    });

    const invalidSubmit = samplePayload('evt-invalid-submit');
    const invalidReconcile = samplePayload('evt-invalid-reconcile');
    await assert.rejects(
      client.hello('invalid request id'),
      (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
    );
    await assert.rejects(
      client.submitWorkflowSignal('req-invalid-submit', {
        ...invalidSubmit,
        signal: { ...invalidSubmit.signal, findingCount: 1 },
      }),
      (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_SIGNAL,
    );
    await assert.rejects(
      client.reconcileWorkflowSignal('req-invalid-reconcile', {
        signal: { ...invalidReconcile.signal, eventId: 'invalid event id' },
      }),
      (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_SIGNAL,
    );

    assert.equal(measurements.length, 0, 'encoding failure cannot start parent timing');
    assert.equal(existsSync(invocationLog), false, 'encoding failure cannot spawn a process');
    assert.equal(
      existsSync(stateDir),
      false,
      'encoding failure cannot acquire stdin or write state',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function environmentCaptureExecutable(root: string, capturePath: string): string {
  assert.doesNotMatch(process.execPath, /[\r\n]/);
  const executable = join(root, 'capture-environment');
  const source = `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv[2] === '--capture-runtime-environment') {
  process.stdout.write(JSON.stringify(process.env));
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input.trim());
  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.env));
  process.stdout.write(JSON.stringify({
    protocol: 'aizign',
    version: 1,
    requestId: request.requestId,
    kind: 'hello',
    ok: true,
    payload: {
      protocolVersion: 1,
      journalSchemaVersion: 1,
      capabilities: ['workflow.signal.submit', 'workflow.signal.reconcile'],
      package: { name: 'aizign', version: '0.1.0' },
    },
  }) + '\\n');
});
`;
  writeFileSync(executable, source, { mode: 0o755 });
  return executable;
}

test('OneShotCoreClient enforces the complete native child-environment allowlist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-env-'));
  const capturePath = join(root, 'environment.json');
  const sensitive = {
    AIZIGN_FAKE_FAULT: 'journal-unknown',
    AIZIGN_PRIVATE_HOOK: 'private-hook',
    DSH_CALL_ID: 'call-native-1',
    DSH_SESSION_ID: 'session-native-1',
    HOME: '/synthetic/home',
    OPENAI_API_KEY: 'synthetic-non-secret-value',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://diagnostic.invalid',
    PROVIDER_ID: 'provider-native-1',
    XDG_CONFIG_HOME: '/synthetic/config',
  } as const;
  const names = ['PATH', ...Object.keys(sensitive)];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, sensitive);
    const command = environmentCaptureExecutable(root, capturePath);
    const baseline = spawnSync(command, ['--capture-runtime-environment'], {
      encoding: 'utf8',
      env: {},
    });
    assert.equal(baseline.status, 0, baseline.stderr);
    const runtimeEnvironment = JSON.parse(baseline.stdout) as Record<string, string>;
    for (const name of Object.keys(sensitive)) {
      assert.equal(runtimeEnvironment[name], undefined, `clean runtime baseline excludes ${name}`);
    }

    process.env.PATH = '/synthetic/bin:/usr/bin';
    const withPath = new OneShotCoreClient({ command, stateDir: '.', timeoutMs: 2_000 });
    assert.equal((await withPath.hello('environment-path-present')).kind, 'ok');
    assert.deepEqual(
      JSON.parse(readFileSync(capturePath, 'utf8')),
      { ...runtimeEnvironment, PATH: '/synthetic/bin:/usr/bin' },
      'adapter-env-path-present-exact / adapter-env-sensitive-parent-excluded',
    );

    delete process.env.PATH;
    const withoutPath = new OneShotCoreClient({ command, stateDir: '.', timeoutMs: 2_000 });
    assert.equal((await withoutPath.hello('environment-path-absent')).kind, 'ok');
    assert.deepEqual(
      JSON.parse(readFileSync(capturePath, 'utf8')),
      runtimeEnvironment,
      'adapter-env-path-absent-empty',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('OneShotCoreClient reports parent timing without exposing request identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-parent-timing-'));
  try {
    const measurements: ParentTimingMeasurement[] = [];
    const command = fakeCoreExecutable(join(root, 'bin'));
    const client = new OneShotCoreClient({
      command,
      stateDir: join(root, 'state'),
      timeoutMs: 5_000,
      timingSink: (measurement) => {
        measurements.push(measurement);
      },
    });
    const outcome = await client.submitWorkflowSignal('req-parent', samplePayload('evt-parent'));
    assert.deepEqual(outcome, { kind: 'accepted', eventId: 'evt-parent' });
    assert.equal(measurements.length, 1);
    assert.equal(measurements[0]?.operation_kind, 'workflow.signal.submit');
    assert.equal(measurements[0]?.outcome, 'accepted');
    assert.equal(typeof measurements[0]?.spawn_to_exit_ms, 'number');
    assert.equal(typeof measurements[0]?.response_first_byte_ms, 'number');
    assert.ok(!JSON.stringify(measurements[0]).includes('evt-parent'));

    const conflicting = samplePayload('evt-parent');
    assert.equal(
      (
        await client.submitWorkflowSignal('req-conflict', {
          expected: conflicting.expected,
          signal: { ...conflicting.signal, kind: 'blocked', shortErrorCode: 'CONFLICTING' },
        })
      ).kind,
      'rejected',
    );
    assert.equal(measurements[1]?.outcome, 'conflict');
    assert.equal(measurements[1]?.error_code, 'EVENT_CONFLICT');

    const unknownMeasurements: ParentTimingMeasurement[] = [];
    const unknown = new OneShotCoreClient({
      command: fakeCoreExecutable(join(root, 'unknown-bin'), { fault: 'journal-unknown' }),
      stateDir: join(root, 'unknown'),
      timeoutMs: 5_000,
      timingSink: (measurement) => {
        unknownMeasurements.push(measurement);
      },
    });
    assert.equal(
      (await unknown.submitWorkflowSignal('req-unknown', samplePayload('evt-unknown'))).kind,
      'unknown',
    );
    assert.equal(unknownMeasurements[0]?.outcome, 'unknown');
    assert.equal(unknownMeasurements[0]?.error_code, 'JOURNAL_OUTCOME_UNKNOWN');
    assert.equal(unknownMeasurements[0]?.unknown_reason, 'reported_unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('framed hello requires request id and kind correlation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-hello-correlation-'));
  try {
    const cases = [
      ['hello-request-id-mismatch', 'wrong-request-id'],
      ['hello-kind-mismatch', 'wrong-kind'],
      ['hello-request-id-mismatch/hello-kind-mismatch', 'null-correlation'],
    ] as const;
    for (const [caseId, fault] of cases) {
      const client = new OneShotCoreClient({
        command: fakeCoreExecutable(join(root, `bin-${fault}`), { fault }),
        stateDir: join(root, `state-${fault}`),
        timeoutMs: 5_000,
      });
      const outcome = await client.hello(`req-${fault}`);
      assert.equal(outcome.kind, 'unknown', caseId);
      if (outcome.kind === 'unknown') {
        assert.equal(outcome.reason, 'correlation_mismatch', caseId);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every operation uses the exact canonical argv and framed stdin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-canonical-argv-'));
  try {
    const argvLog = join(root, 'argv.jsonl');
    const stateDir = join(root, 'state');
    const client = new OneShotCoreClient({
      command: fakeCoreExecutable(join(root, 'argv-bin'), { argvLog }),
      stateDir,
      timeoutMs: 5_000,
    });
    assert.equal((await client.hello('req-argv-hello')).kind, 'ok', 'req-valid');
    assert.equal(
      (await client.submitWorkflowSignal('req-argv-submit', samplePayload('evt-argv'))).kind,
      'accepted',
    );
    assert.equal(
      (
        await client.reconcileWorkflowSignal('req-argv-reconcile', {
          signal: samplePayload('evt-argv').signal,
        })
      ).kind,
      'accepted',
    );
    const invocations = readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(invocations, [
      ['handle', '--state', stateDir],
      ['handle', '--state', stateDir],
      ['handle', '--state', stateDir],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OneShotCoreClient discloses timing only after correlation and isolates sink failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-timing-boundary-'));
  try {
    const command = fakeCoreExecutable(join(root, 'bin'));
    const measurements: ParentTimingMeasurement[] = [];
    const uncorrelated = new OneShotCoreClient({
      command: fakeCoreExecutable(join(root, 'uncorrelated-bin'), {
        fault: 'unknown-valid-error-code-wrong-request-id',
      }),
      stateDir: join(root, 'uncorrelated'),
      timeoutMs: 5_000,
      timingSink: (measurement) => {
        measurements.push(measurement);
      },
    });
    const outcome = await uncorrelated.submitWorkflowSignal(
      'req-uncorrelated',
      samplePayload('evt-uncorrelated'),
    );
    assert.equal(outcome.kind, 'unknown');
    assert.equal(measurements.length, 1);
    assert.equal(measurements[0]?.outcome, 'unknown');
    assert.equal(measurements[0]?.unknown_reason, 'correlation_mismatch');
    assert.equal(measurements[0]?.error_code, undefined);
    assert.ok(!JSON.stringify(measurements).includes('FUTURE_OUTCOME_UNKNOWN'));

    const throwing = new OneShotCoreClient({
      command,
      stateDir: join(root, 'throwing'),
      timeoutMs: 5_000,
      timingSink: () => {
        throw new Error('metric sink unavailable');
      },
    });
    assert.equal(
      (await throwing.submitWorkflowSignal('req-throwing', samplePayload('evt-throwing'))).kind,
      'accepted',
    );

    const rejecting = new OneShotCoreClient({
      command,
      stateDir: join(root, 'rejecting'),
      timeoutMs: 5_000,
      timingSink: async () => {
        throw new Error('async metric sink unavailable');
      },
    });
    assert.equal(
      (await rejecting.submitWorkflowSignal('req-rejecting', samplePayload('evt-rejecting'))).kind,
      'accepted',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const binary = process.env.AIZIGN_BINARY;
test('OneShotCoreClient passes the core scenarios against the real aizign binary', {
  skip: binary === undefined ? 'set AIZIGN_BINARY to a built aizign binary' : false,
}, async () => {
  await runCoreScenarios((config) => new OneShotCoreClient(config), { command: binary ?? '' });
});
