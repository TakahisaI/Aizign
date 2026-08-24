/**
 * This adapter's core client against the fake core (every unknown path) and,
 * when `AIZIGN_BINARY` is set, against the real binary.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fakeCoreCommand,
  runCoreClientConformance,
  runCoreScenarios,
  samplePayload,
} from '@aizign/adapter-testkit';
import type { ParentTimingMeasurement } from '@aizign/protocol';
import { OneShotCoreClient } from '../../src/core-client/one-shot-client.ts';

test('OneShotCoreClient satisfies the core-client conformance', async () => {
  await runCoreClientConformance((config) => new OneShotCoreClient(config));
});

test('OneShotCoreClient reports parent timing without exposing request identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-parent-timing-'));
  try {
    const measurements: ParentTimingMeasurement[] = [];
    const client = new OneShotCoreClient({
      ...fakeCoreCommand(),
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
      ...fakeCoreCommand(),
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

const binary = process.env.AIZIGN_BINARY;
test('OneShotCoreClient passes the core scenarios against the real aizign binary', {
  skip: binary === undefined ? 'set AIZIGN_BINARY to a built aizign binary' : false,
}, async () => {
  await runCoreScenarios((config) => new OneShotCoreClient(config), { command: binary ?? '' });
});
