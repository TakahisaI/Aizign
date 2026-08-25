/**
 * TypeScript reference scenarios for the submit/reconcile `CoreClient`,
 * proven against the fake core. Passing this runner establishes only the
 * core-client operation boundary, not harness-adapter conformance.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  type CoreClient,
  type CoreClientConfig,
  codes,
  MAX_REQUEST_BYTES,
  type ParentTimingMeasurement,
  PROTOCOL_VERSION,
  ProtocolError,
  type WorkflowSignalSubmitPayload,
} from '@aizign/protocol';
import { fakeCoreCommand } from './fake-core-path.ts';

export type CoreClientFactory = (config: CoreClientConfig) => CoreClient;

export interface ConformanceOptions {
  /** Timeout used for the hang scenario; keep it short. Default 500ms. */
  readonly hangTimeoutMs?: number;
}

/** A valid payload bound to a fixed expectation. */
export function samplePayload(eventId: string): WorkflowSignalSubmitPayload {
  const expected = {
    workflowId: 'wf-conformance',
    assignmentId: 'as-implementation',
    attemptId: 'attempt-implementation',
    role: 'implementation',
    artifactRevision: 'rev-a',
    candidateDigest: {
      algorithm: 'sha256',
      hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  } as const;
  return { expected, signal: { ...expected, eventId, kind: 'implementation_ready' } };
}

/** Keys that must never appear anywhere in a frame sent to the core. */
export const FORBIDDEN_KEYS: readonly string[] = [
  'prompt',
  'output',
  'reasoning',
  'token',
  'credential',
  'sessionId',
  'threadId',
  'turnId',
  'callId',
  'providerId',
  'deliveryId',
];

/**
 * Every request frame the fake core received for `stateDir`, decoded as
 * JSON. Harness-native tests can inspect the complete envelope and compare it
 * with actual native identifiers; the key scan alone cannot prove value
 * provenance.
 */
export function readFakeRequests(stateDir: string): unknown[] {
  const path = join(stateDir, 'fake-requests.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return line;
      }
    });
}

/**
 * Asserts that a JSON value uses none of the known forbidden keys. This is a
 * key-level convenience check, not proof of identifier or value provenance.
 */
export function assertMetadataOnly(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertMetadataOnly(item, `${path}[${index}]`);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!FORBIDDEN_KEYS.includes(key), `${path}.${key} must not reach the core`);
      assertMetadataOnly(child, `${path}.${key}`);
    }
  }
}

/** How to reach a core: the fake, or a real `aizign` binary. */
export interface CoreCommand {
  readonly command: string;
  readonly args?: readonly string[];
}

/**
 * The scenarios every core must pass, fake or real: handshake, then
 * accepted → duplicate → conflict across separate processes, then an
 * expectation mismatch. Throws (via `node:assert`) on the first violation.
 */
export async function runCoreScenarios(
  factory: CoreClientFactory,
  core: CoreCommand,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'aizign-core-scenarios-'));
  try {
    const make = (name: string) =>
      factory({
        command: core.command,
        args: core.args ?? [],
        stateDir: join(root, name),
        timeoutMs: 10_000,
      });

    const hello = await make('hello').hello('req-hello');
    assert.equal(hello.kind, 'ok', `hello: ${JSON.stringify(hello)}`);
    if (hello.kind === 'ok') {
      assert.equal(hello.info.protocolVersion, PROTOCOL_VERSION);
      assert.ok(hello.info.capabilities.includes(CAPABILITY_WORKFLOW_SIGNAL_SUBMIT));
      assert.ok(hello.info.capabilities.includes(CAPABILITY_WORKFLOW_SIGNAL_RECONCILE));
    }

    const client = make('signals');
    const first = await client.submitWorkflowSignal('req-1', samplePayload('evt-1'));
    assert.deepEqual(first, { kind: 'accepted', eventId: 'evt-1' });
    const again = await client.submitWorkflowSignal('req-2', samplePayload('evt-1'));
    assert.deepEqual(again, { kind: 'duplicate', eventId: 'evt-1' });
    const conflicting = samplePayload('evt-1');
    const conflict = await client.submitWorkflowSignal('req-3', {
      expected: conflicting.expected,
      signal: { ...conflicting.signal, kind: 'blocked', shortErrorCode: 'CONFLICTING' },
    });
    assert.equal(conflict.kind, 'rejected');
    if (conflict.kind === 'rejected') assert.equal(conflict.code, 'EVENT_CONFLICT');

    const mismatched = samplePayload('evt-2');
    const mismatch = await client.submitWorkflowSignal('req-4', {
      expected: { ...mismatched.expected, artifactRevision: 'rev-b' },
      signal: mismatched.signal,
    });
    assert.equal(mismatch.kind, 'rejected');
    if (mismatch.kind === 'rejected') assert.equal(mismatch.code, 'REVISION_MISMATCH');

    const attemptMismatchPayload = samplePayload('evt-attempt-mismatch');
    const attemptMismatch = await client.submitWorkflowSignal('req-5', {
      expected: { ...attemptMismatchPayload.expected, attemptId: 'attempt-other' },
      signal: attemptMismatchPayload.signal,
    });
    assert.equal(attemptMismatch.kind, 'rejected');
    if (attemptMismatch.kind === 'rejected') {
      assert.equal(attemptMismatch.code, 'ATTEMPT_MISMATCH');
    }

    const digestMismatchPayload = samplePayload('evt-digest-mismatch');
    const digestMismatch = await client.submitWorkflowSignal('req-6', {
      expected: {
        ...digestMismatchPayload.expected,
        candidateDigest: {
          algorithm: 'sha256',
          hex: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
      signal: digestMismatchPayload.signal,
    });
    assert.equal(digestMismatch.kind, 'rejected');
    if (digestMismatch.kind === 'rejected') {
      assert.equal(digestMismatch.code, 'CANDIDATE_DIGEST_MISMATCH');
    }

    const changedCandidate = samplePayload('evt-candidate-rebound');
    const candidateRebinding = await client.submitWorkflowSignal('req-7', {
      expected: {
        ...changedCandidate.expected,
        candidateDigest: {
          algorithm: 'sha256',
          hex: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
      signal: {
        ...changedCandidate.signal,
        candidateDigest: {
          algorithm: 'sha256',
          hex: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
    });
    assert.deepEqual(candidateRebinding, {
      kind: 'accepted',
      eventId: 'evt-candidate-rebound',
    });

    assert.deepEqual(
      await client.reconcileWorkflowSignal('req-reconcile-accepted', {
        signal: samplePayload('evt-1').signal,
      }),
      { kind: 'accepted', eventId: 'evt-1' },
    );
    assert.deepEqual(
      await client.reconcileWorkflowSignal('req-reconcile-conflict', {
        signal: {
          ...samplePayload('evt-1').signal,
          kind: 'blocked',
          shortErrorCode: 'CHANGED',
        },
      }),
      { kind: 'conflict', eventId: 'evt-1' },
    );
    assert.deepEqual(
      await client.reconcileWorkflowSignal('req-reconcile-absent', {
        signal: samplePayload('evt-absent').signal,
      }),
      { kind: 'absent', eventId: 'evt-absent' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The unknown-outcome scenarios, which need the fake core's fault
 * injection: never success, never failure, never a retry.
 */
export async function runFaultScenarios(
  factory: CoreClientFactory,
  options: ConformanceOptions = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'aizign-fault-scenarios-'));
  try {
    const fake = fakeCoreCommand();
    const make = (name: string, env: Record<string, string>, timeoutMs = 10_000) =>
      factory({ ...fake, env, stateDir: join(root, name), timeoutMs });

    const scenarios: Array<[string, string, string]> = [
      ['no-response', 'no_response', 'process exits without a frame'],
      ['garbage', 'undecodable_response', 'stdout is not a frame'],
      ['journal-unknown', 'reported_unknown', 'the core reports JOURNAL_OUTCOME_UNKNOWN'],
      ['exit-2', 'no_response', 'process fails before answering'],
      ['wrong-request-id', 'correlation_mismatch', 'the response answers another request'],
      ['wrong-kind', 'correlation_mismatch', 'the response has another kind'],
      ['wrong-event-id', 'correlation_mismatch', 'the response names another event'],
      ['oversized', 'oversized_response', 'the response exceeds the frame bound'],
      ['two-frames', 'undecodable_response', 'stdout carries two frames'],
      ['trailing-garbage', 'undecodable_response', 'stdout carries a frame and then prose'],
    ];
    for (const [fault, reason, description] of scenarios) {
      const outcome = await make(`fault-${fault}`, {
        AIZIGN_FAKE_FAULT: fault,
      }).submitWorkflowSignal('req-fault', samplePayload('evt-fault'));
      assert.equal(outcome.kind, 'unknown', `${description}: ${JSON.stringify(outcome)}`);
      if (outcome.kind === 'unknown') assert.equal(outcome.reason, reason, description);
    }
    const hang = await make(
      'fault-hang',
      { AIZIGN_FAKE_FAULT: 'hang' },
      options.hangTimeoutMs ?? 500,
    ).submitWorkflowSignal('req-hang', samplePayload('evt-hang'));
    assert.equal(hang.kind, 'unknown');
    if (hang.kind === 'unknown') assert.equal(hang.reason, 'timeout');

    // cancellation: the caller's abort kills the process; the outcome is unknown.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await make('fault-abort', { AIZIGN_FAKE_FAULT: 'hang' }).submitWorkflowSignal(
      'req-abort',
      samplePayload('evt-abort'),
      { signal: controller.signal },
    );
    assert.equal(aborted.kind, 'unknown');
    if (aborted.kind === 'unknown') assert.equal(aborted.reason, 'aborted');

    const missing = factory({
      command: join(root, 'no-such-binary'),
      stateDir: join(root, 'missing'),
      timeoutMs: 1_000,
    });
    const spawnFailed = await missing.submitWorkflowSignal(
      'req-missing',
      samplePayload('evt-missing'),
    );
    assert.equal(spawnFailed.kind, 'unknown');
    if (spawnFailed.kind === 'unknown') assert.equal(spawnFailed.reason, 'spawn_failed');

    const timeoutState = join(root, 'reconcile-handler-timeout');
    const timeoutClient = factory({
      ...fake,
      env: { AIZIGN_FAKE_FAULT: 'handler-timeout' },
      stateDir: timeoutState,
      timeoutMs: 10_000,
    });
    const timeout = await timeoutClient.reconcileWorkflowSignal('req-reconcile-timeout', {
      signal: samplePayload('evt-timeout').signal,
    });
    assert.equal(timeout.kind, 'unknown');
    if (timeout.kind === 'unknown') {
      assert.equal(timeout.reason, 'correlation_mismatch');
      assert.equal(timeout.reportedCode, 'HANDLER_TIMEOUT');
    }
    assertMetadataOnly(readFakeRequests(timeoutState));
    assert.equal(
      readFakeRequests(timeoutState).length,
      1,
      'reconciliation does not retry an uncorrelated watchdog response',
    );

    const conflictMeasurements: ParentTimingMeasurement[] = [];
    const reportedConflict = factory({
      ...fake,
      env: { AIZIGN_FAKE_FAULT: 'event-conflict-error' },
      stateDir: join(root, 'reconcile-event-conflict-error'),
      timeoutMs: 10_000,
      timingSink: (measurement) => {
        conflictMeasurements.push(measurement);
      },
    });
    const conflictUnknown = await reportedConflict.reconcileWorkflowSignal(
      'req-reconcile-event-conflict-error',
      { signal: samplePayload('evt-reconcile-event-conflict-error').signal },
    );
    assert.equal(conflictUnknown.kind, 'unknown');
    if (conflictUnknown.kind === 'unknown') {
      assert.equal(conflictUnknown.reason, 'reported_unknown');
      assert.equal(conflictUnknown.reportedCode, 'EVENT_CONFLICT');
    }
    assert.deepEqual(
      {
        outcome: conflictMeasurements[0]?.outcome,
        error_code: conflictMeasurements[0]?.error_code,
        unknown_reason: conflictMeasurements[0]?.unknown_reason,
      },
      {
        outcome: 'unknown',
        error_code: 'EVENT_CONFLICT',
        unknown_reason: 'reported_unknown',
      },
    );

    const reconciliationFaults: Array<[string, string]> = [
      ['garbage', 'undecodable_response'],
      ['oversized', 'oversized_response'],
      ['wrong-request-id', 'correlation_mismatch'],
      ['wrong-kind', 'correlation_mismatch'],
      ['wrong-event-id', 'correlation_mismatch'],
      ['two-frames', 'undecodable_response'],
      ['trailing-garbage', 'undecodable_response'],
    ];
    for (const [fault, reason] of reconciliationFaults) {
      const stateDir = join(root, `reconcile-fault-${fault}`);
      const outcome = await make(`reconcile-fault-${fault}`, {
        AIZIGN_FAKE_FAULT: fault,
      }).reconcileWorkflowSignal(`req-reconcile-${fault}`, {
        signal: samplePayload(`evt-reconcile-${fault}`).signal,
      });
      assert.equal(outcome.kind, 'unknown', `${fault}: ${JSON.stringify(outcome)}`);
      if (outcome.kind === 'unknown') assert.equal(outcome.reason, reason, fault);
      const requests = readFakeRequests(stateDir);
      assertMetadataOnly(requests);
      if (fault !== 'garbage') {
        assert.equal(requests.length, 1, `${fault}: reconciliation must not retry`);
      }
    }

    const oversizedState = join(root, 'oversized-request');
    const oversizedInvocationLog = join(root, 'oversized-request-invocations.log');
    const oversized = factory({
      ...fake,
      env: { AIZIGN_FAKE_INVOCATION_LOG: oversizedInvocationLog },
      stateDir: oversizedState,
      timeoutMs: 10_000,
    });
    await assert.rejects(
      oversized.submitWorkflowSignal(
        `req-${'x'.repeat(MAX_REQUEST_BYTES)}`,
        samplePayload('evt-oversized-request'),
      ),
      (error: unknown) => error instanceof ProtocolError && error.code === codes.REQUEST_TOO_LARGE,
      'an oversized outbound request fails locally before transport',
    );
    assert.equal(
      existsSync(oversizedInvocationLog),
      false,
      'an oversized outbound request never spawns the fake core',
    );
    assert.equal(
      readFakeRequests(oversizedState).length,
      0,
      'an oversized outbound request never reaches the core',
    );

    const absentState = join(root, 'absent-no-resubmit');
    const absent = factory({ ...fake, stateDir: absentState, timeoutMs: 10_000 });
    assert.deepEqual(
      await absent.reconcileWorkflowSignal('req-absent-no-resubmit', {
        signal: samplePayload('evt-absent-no-resubmit').signal,
      }),
      { kind: 'absent', eventId: 'evt-absent-no-resubmit' },
    );
    const absentRequests = readFakeRequests(absentState);
    assert.equal(absentRequests.length, 1, 'absent causes no implicit resubmission');
    assert.equal(
      (absentRequests[0] as { kind?: unknown }).kind,
      'workflow.signal.reconcile',
      'the only request is the read-only reconciliation',
    );

    const lostAckState = join(root, 'lost-ack-reconciliation');
    const lostAck = factory({
      ...fake,
      env: { AIZIGN_FAKE_FAULT: 'journal-unknown' },
      stateDir: lostAckState,
      timeoutMs: 10_000,
    });
    const attempted = samplePayload('evt-lost-ack');
    assert.equal((await lostAck.submitWorkflowSignal('req-lost-ack', attempted)).kind, 'unknown');
    const restarted = factory({ ...fake, stateDir: lostAckState, timeoutMs: 10_000 });
    assert.deepEqual(
      await restarted.reconcileWorkflowSignal('req-restarted', { signal: attempted.signal }),
      { kind: 'accepted', eventId: 'evt-lost-ack' },
    );
    assert.equal(
      readFakeRequests(lostAckState).length,
      2,
      'one submit and one reconciliation occur without a blind submit retry',
    );

    const rejectingSink = factory({
      ...fake,
      stateDir: join(root, 'async-rejecting-timing-sink'),
      timeoutMs: 10_000,
      timingSink: async () => {
        throw new Error('metric backend unavailable');
      },
    });
    const accepted = await rejectingSink.submitWorkflowSignal(
      'req-async-rejecting-sink',
      samplePayload('evt-async-rejecting-sink'),
    );
    assert.equal(accepted.kind, 'accepted');
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The complete TypeScript reference `CoreClient` scenario set, against the
 * fake core.
 */
export async function runCoreClientConformance(
  factory: CoreClientFactory,
  options: ConformanceOptions = {},
): Promise<void> {
  await runCoreScenarios(factory, fakeCoreCommand());
  await runFaultScenarios(factory, options);
}
