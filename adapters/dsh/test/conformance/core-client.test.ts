/**
 * This adapter's core client against the fake core (every unknown path) and,
 * when `AIZIGN_BINARY` is set, against the real binary.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      command: fakeCoreExecutable(join(root, 'bin')),
      env: { AIZIGN_FAKE_INVOCATION_LOG: invocationLog },
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

test('OneShotCoreClient does not inherit synthetic parent credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-env-'));
  const credentialName = 'AIZIGN_TEST_SYNTHETIC_CREDENTIAL';
  const previous = process.env[credentialName];
  process.env[credentialName] = 'synthetic-non-secret-value';
  try {
    const client = new OneShotCoreClient({
      command: fakeCoreExecutable(join(root, 'bin')),
      stateDir: '.',
      timeoutMs: 2_000,
      env: { AIZIGN_FAKE_ASSERT_ENV_ABSENT: credentialName },
    });
    const outcome = await client.hello('environment-boundary');
    assert.equal(outcome.kind, 'ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env[credentialName];
    else process.env[credentialName] = previous;
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
      command,
      env: { AIZIGN_FAKE_FAULT: 'journal-unknown' },
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
    const command = fakeCoreExecutable(join(root, 'bin'));
    const cases = [
      ['hello-request-id-mismatch', 'wrong-request-id'],
      ['hello-kind-mismatch', 'wrong-kind'],
      ['hello-request-id-mismatch/hello-kind-mismatch', 'null-correlation'],
    ] as const;
    for (const [caseId, fault] of cases) {
      const client = new OneShotCoreClient({
        command,
        env: { AIZIGN_FAKE_FAULT: fault },
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
    const command = fakeCoreExecutable(join(root, 'bin'));
    const argvLog = join(root, 'argv.jsonl');
    const stateDir = join(root, 'state');
    const client = new OneShotCoreClient({
      command,
      env: { AIZIGN_FAKE_ARGV_LOG: argvLog },
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
      command,
      env: { AIZIGN_FAKE_FAULT: 'unknown-valid-error-code-wrong-request-id' },
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
