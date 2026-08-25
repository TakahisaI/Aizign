import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ParentTimingMeasurement } from '@aizign/protocol';
import { assertMetadataOnly, runCoreClientConformance, samplePayload } from './conformance.ts';
import { fakeCoreCommand } from './fake-core-path.ts';
import { ReferenceOneShotClient } from './reference-client.ts';

test('the reference client satisfies the core-client conformance', async () => {
  await runCoreClientConformance((config) => new ReferenceOneShotClient(config));
});

test('assertMetadataOnly rejects harness identity and contents at any depth', () => {
  assertMetadataOnly(samplePayload('evt-1'));
  assert.throws(() => assertMetadataOnly({ signal: { sessionId: 'x' } }), /sessionId/);
  assert.throws(() => assertMetadataOnly({ providerId: 'provider-1' }), /providerId/);
  assert.throws(() => assertMetadataOnly({ deliveryId: 'delivery-1' }), /deliveryId/);
  assert.throws(() => assertMetadataOnly([{ nested: { prompt: 'x' } }]), /prompt/);
});

test('parent timing is metadata-only and sink failures do not change outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-parent-timing-'));
  try {
    const measurements: ParentTimingMeasurement[] = [];
    const client = new ReferenceOneShotClient({
      ...fakeCoreCommand(),
      stateDir: join(root, 'state'),
      timeoutMs: 5_000,
      timingSink: (measurement) => {
        measurements.push(measurement);
      },
    });
    assert.deepEqual(await client.submitWorkflowSignal('req-timed', samplePayload('evt-timed')), {
      kind: 'accepted',
      eventId: 'evt-timed',
    });
    assert.equal(measurements.length, 1);
    const [measurement] = measurements;
    assert.equal(measurement?.operation_kind, 'workflow.signal.submit');
    assert.equal(measurement?.outcome, 'accepted');
    assert.equal(typeof measurement?.spawn_to_exit_ms, 'number');
    assert.equal(typeof measurement?.response_first_byte_ms, 'number');
    const encoded = JSON.stringify(measurement);
    for (const forbidden of ['req-timed', 'evt-timed', root, 'stateDir', 'prompt', 'credential']) {
      assert.ok(!encoded.includes(forbidden), `${forbidden}: ${encoded}`);
    }

    const conflicting = samplePayload('evt-timed');
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
    const unknown = new ReferenceOneShotClient({
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

    const throwing = new ReferenceOneShotClient({
      ...fakeCoreCommand(),
      stateDir: join(root, 'throwing'),
      timeoutMs: 5_000,
      timingSink: () => {
        throw new Error('metric sink unavailable');
      },
    });
    assert.deepEqual(await throwing.submitWorkflowSignal('req-ok', samplePayload('evt-ok')), {
      kind: 'accepted',
      eventId: 'evt-ok',
    });

    const rejecting = new ReferenceOneShotClient({
      ...fakeCoreCommand(),
      stateDir: join(root, 'rejecting'),
      timeoutMs: 5_000,
      timingSink: async () => {
        throw new Error('async metric sink unavailable');
      },
    });
    assert.deepEqual(
      await rejecting.submitWorkflowSignal('req-async', samplePayload('evt-async')),
      {
        kind: 'accepted',
        eventId: 'evt-async',
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
