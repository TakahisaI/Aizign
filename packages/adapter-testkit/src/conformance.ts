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
  codes,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  type WorkflowSignalSubmitPayload,
} from '@aizign/protocol';
import { fakeCoreExecutable } from './fake-core-path.ts';

/** Process fixture values supplied to a production client by the test runner. */
export interface CoreClientFixtureConfig {
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stateDir: string;
  readonly timeoutMs: number;
}

export type CoreClientFactory = (config: CoreClientFixtureConfig) => CoreClient;

export interface ConformanceOptions {
  /** Timeout used for the hang scenario; keep it short. Default 500ms. */
  readonly hangTimeoutMs?: number;
  /** Runtime evidence hook, called only after the named assertion succeeds. */
  readonly caseExecuted?: (...caseIds: string[]) => void;
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
}

/**
 * The scenarios every core must pass, fake or real: handshake, then
 * accepted → duplicate → conflict across separate processes, then an
 * expectation mismatch. Throws (via `node:assert`) on the first violation.
 */
export async function runCoreScenarios(
  factory: CoreClientFactory,
  core: CoreCommand,
  options: ConformanceOptions = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'aizign-core-scenarios-'));
  try {
    const make = (name: string) =>
      factory({
        command: core.command,
        stateDir: join(root, name),
        timeoutMs: 10_000,
      });

    const hello = await make('hello').hello('req-hello');
    assert.equal(hello.kind, 'ok', `req-valid: ${JSON.stringify(hello)}`);
    if (hello.kind === 'ok') {
      assert.equal(hello.info.protocolVersion, PROTOCOL_VERSION);
      assert.ok(hello.info.capabilities.includes(CAPABILITY_WORKFLOW_SIGNAL_SUBMIT));
      assert.ok(hello.info.capabilities.includes(CAPABILITY_WORKFLOW_SIGNAL_RECONCILE));
    }
    assert.equal(
      existsSync(join(root, 'hello')),
      false,
      'hello-nonexistent-state: framed hello does not touch stateDir',
    );
    options.caseExecuted?.('req-valid', 'hello-nonexistent-state');

    const client = make('signals');
    const first = await client.submitWorkflowSignal('req-1', samplePayload('evt-1'));
    assert.deepEqual(first, { kind: 'accepted', eventId: 'evt-1' }, 'res-valid-zero');
    options.caseExecuted?.('res-valid-zero');
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
    const fake = { command: fakeCoreExecutable(join(root, 'fake-bin')) };
    const make = (name: string, env: Record<string, string>, timeoutMs = 10_000) =>
      factory({ ...fake, env, stateDir: join(root, name), timeoutMs });

    const scenarios: Array<[readonly string[], string, string, string]> = [
      [['res-empty-zero'], 'no-response', 'no_response', 'process exits without a frame'],
      [[], 'garbage', 'undecodable_response', 'stdout is not a frame'],
      [[], 'journal-unknown', 'reported_unknown', 'the core reports JOURNAL_OUTCOME_UNKNOWN'],
      [['proc-abnormal-termination'], 'exit-2', 'no_response', 'process fails before answering'],
      [[], 'wrong-request-id', 'correlation_mismatch', 'the response answers another request'],
      [[], 'wrong-kind', 'correlation_mismatch', 'the response has another kind'],
      [[], 'null-correlation', 'correlation_mismatch', 'the response has null correlation'],
      [[], 'wrong-event-id', 'correlation_mismatch', 'the response names another event'],
      [
        ['res-over-bound'],
        'oversized',
        'oversized_response',
        'the response exceeds the frame bound',
      ],
      [
        ['res-no-lf'],
        'no-lf-response',
        'undecodable_response',
        'stdout closes before the required LF',
      ],
      [['res-bom'], 'bom-response', 'undecodable_response', 'a BOM-prefixed body is not accepted'],
      [
        ['res-exact-bound'],
        'exact-max',
        'reported_unknown',
        'an exact-max body plus LF is accepted',
      ],
      [
        ['res-post-lf-space'],
        'post-lf-space',
        'undecodable_response',
        'a space follows the response LF',
      ],
      [['res-post-lf-tab'], 'post-lf-tab', 'undecodable_response', 'a tab follows the response LF'],
      [['res-post-lf-cr'], 'post-lf-cr', 'undecodable_response', 'a CR follows the response LF'],
      [
        ['res-post-lf-second-lf'],
        'post-lf-lf',
        'undecodable_response',
        'another LF follows the response LF',
      ],
      [['res-crlf'], 'crlf-response', 'undecodable_response', 'CRLF is not a profile terminator'],
      [
        ['res-valid-nonzero'],
        'nonzero-with-frame',
        'undecodable_response',
        'a valid-looking frame cannot override nonzero exit',
      ],
      [
        ['res-post-lf-second-frame'],
        'two-frames',
        'undecodable_response',
        'stdout carries two frames',
      ],
      [[], 'trailing-garbage', 'undecodable_response', 'stdout carries a frame and then prose'],
      [
        ['proc-signal-terminated', 'proc-missing-exit-code'],
        'signal-terminated',
        'no_response',
        'the process terminates by signal without a frame',
      ],
      [
        ['res-invalid-utf8'],
        'invalid-utf8',
        'undecodable_response',
        'a raw invalid UTF-8 byte is never decoded as a rejection',
      ],
      [
        [],
        'unknown-valid-error-code',
        'reported_unknown',
        'an unrecognized well-formed peer code is not a definitive rejection',
      ],
    ];
    for (const [caseIds, fault, reason, description] of scenarios) {
      const label = caseIds.length > 0 ? caseIds.join('/') : fault;
      const outcome = await make(`fault-${fault}`, {
        AIZIGN_FAKE_FAULT: fault,
      }).submitWorkflowSignal('req-fault', samplePayload('evt-fault'));
      assert.equal(outcome.kind, 'unknown', `${label}: ${description}: ${JSON.stringify(outcome)}`);
      if (outcome.kind === 'unknown') {
        assert.equal(outcome.reason, reason, `${label}: ${description}`);
        if (fault === 'unknown-valid-error-code') {
          assert.equal(outcome.reportedCode, 'FUTURE_OUTCOME_UNKNOWN');
          assert.equal(
            readFakeRequests(join(root, `fault-${fault}`)).length,
            1,
            'an unrecognized peer code never causes a retry',
          );
        }
        if (fault === 'invalid-utf8') {
          assert.equal(
            readFakeRequests(join(root, `fault-${fault}`)).length,
            1,
            'an invalid UTF-8 response never causes a retry',
          );
        }
      }
      options.caseExecuted?.(...caseIds);
    }

    for (const [caseId, fault] of [
      ['hello-request-id-mismatch', 'wrong-request-id'],
      ['hello-kind-mismatch', 'wrong-kind'],
    ] as const) {
      const outcome = await make(`hello-${fault}`, {
        AIZIGN_FAKE_FAULT: fault,
      }).hello(`req-hello-${fault}`);
      assert.equal(outcome.kind, 'unknown', caseId);
      if (outcome.kind === 'unknown') {
        assert.equal(outcome.reason, 'correlation_mismatch', caseId);
      }
      options.caseExecuted?.(caseId);
    }

    const unsupportedSubmit = await make('operation-version-unsupported-submit', {
      AIZIGN_FAKE_FAULT: 'operation-version-unsupported',
    }).submitWorkflowSignal('req-version-submit', samplePayload('evt-version-submit'));
    assert.equal(unsupportedSubmit.kind, 'rejected', 'version-submit-unsupported');
    if (unsupportedSubmit.kind === 'rejected') {
      assert.equal(
        unsupportedSubmit.code,
        'PROTOCOL_VERSION_UNSUPPORTED',
        'version-submit-unsupported',
      );
    }
    options.caseExecuted?.('version-submit-unsupported');

    const unsupportedReconcile = await make('operation-version-unsupported-reconcile', {
      AIZIGN_FAKE_FAULT: 'operation-version-unsupported',
    }).reconcileWorkflowSignal('req-version-reconcile', {
      signal: samplePayload('evt-version-reconcile').signal,
    });
    assert.equal(unsupportedReconcile.kind, 'unknown', 'version-reconcile-unsupported');
    if (unsupportedReconcile.kind === 'unknown') {
      assert.equal(
        unsupportedReconcile.reason,
        'reported_unknown',
        'version-reconcile-unsupported',
      );
      assert.equal(
        unsupportedReconcile.reportedCode,
        'PROTOCOL_VERSION_UNSUPPORTED',
        'version-reconcile-unsupported',
      );
    }
    options.caseExecuted?.('version-reconcile-unsupported');

    const wrongOperationVersion = await make('wrong-operation-version', {
      AIZIGN_FAKE_FAULT: 'wrong-operation-version',
    }).submitWorkflowSignal('req-wrong-operation-version', samplePayload('evt-wrong-version'));
    assert.equal(wrongOperationVersion.kind, 'unknown', 'wrong numeric operation version');
    if (wrongOperationVersion.kind === 'unknown') {
      assert.equal(
        wrongOperationVersion.reason,
        'undecodable_response',
        'wrong numeric operation version',
      );
    }

    const uncorrelatedCodeState = join(root, 'fault-unknown-code-wrong-request-id');
    const uncorrelatedCodeClient = factory({
      ...fake,
      env: { AIZIGN_FAKE_FAULT: 'unknown-valid-error-code-wrong-request-id' },
      stateDir: uncorrelatedCodeState,
      timeoutMs: 10_000,
    });
    const uncorrelatedCode = await uncorrelatedCodeClient.submitWorkflowSignal(
      'req-unknown-code-wrong-request-id',
      samplePayload('evt-unknown-code-wrong-request-id'),
    );
    assert.equal(uncorrelatedCode.kind, 'unknown');
    if (uncorrelatedCode.kind === 'unknown') {
      assert.equal(uncorrelatedCode.reason, 'correlation_mismatch');
      assert.equal(uncorrelatedCode.reportedCode, 'FUTURE_OUTCOME_UNKNOWN');
    }
    assert.equal(
      readFakeRequests(uncorrelatedCodeState).length,
      1,
      'an uncorrelated error response never causes a retry',
    );

    const hang = await make(
      'fault-hang',
      { AIZIGN_FAKE_FAULT: 'hang' },
      options.hangTimeoutMs ?? 500,
    ).submitWorkflowSignal('req-hang', samplePayload('evt-hang'));
    assert.equal(hang.kind, 'unknown', 'proc-parent-timeout');
    if (hang.kind === 'unknown') assert.equal(hang.reason, 'timeout', 'proc-parent-timeout');
    options.caseExecuted?.('proc-parent-timeout');

    const noClose = await make(
      'fault-no-close-after-frame',
      { AIZIGN_FAKE_FAULT: 'no-close-after-frame' },
      options.hangTimeoutMs ?? 500,
    ).submitWorkflowSignal('req-no-close', samplePayload('evt-no-close'));
    assert.equal(noClose.kind, 'unknown', 'res-valid-stdout-open');
    if (noClose.kind === 'unknown')
      assert.equal(noClose.reason, 'timeout', 'res-valid-stdout-open');
    options.caseExecuted?.('res-valid-stdout-open');

    const processOpen = await make(
      'fault-process-open-after-stdout-close',
      { AIZIGN_FAKE_FAULT: 'process-open-after-stdout-close' },
      options.hangTimeoutMs ?? 500,
    ).submitWorkflowSignal('req-process-open', samplePayload('evt-process-open'));
    assert.equal(processOpen.kind, 'unknown', 'res-valid-process-open');
    if (processOpen.kind === 'unknown') {
      assert.equal(processOpen.reason, 'timeout', 'res-valid-process-open');
    }
    options.caseExecuted?.('res-valid-process-open');

    // cancellation: the caller's abort kills the process; the outcome is unknown.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await make('fault-abort', { AIZIGN_FAKE_FAULT: 'hang' }).submitWorkflowSignal(
      'req-abort',
      samplePayload('evt-abort'),
      { signal: controller.signal },
    );
    assert.equal(aborted.kind, 'unknown', 'proc-caller-abort');
    if (aborted.kind === 'unknown') assert.equal(aborted.reason, 'aborted', 'proc-caller-abort');
    options.caseExecuted?.('proc-caller-abort');

    const missing = factory({
      command: join(root, 'no-such-binary'),
      stateDir: join(root, 'missing'),
      timeoutMs: 1_000,
    });
    const spawnFailed = await missing.submitWorkflowSignal(
      'req-missing',
      samplePayload('evt-missing'),
    );
    assert.equal(spawnFailed.kind, 'unknown', 'proc-spawn-failed');
    if (spawnFailed.kind === 'unknown') {
      assert.equal(spawnFailed.reason, 'spawn_failed', 'proc-spawn-failed');
    }
    options.caseExecuted?.('proc-spawn-failed');

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
    assert.equal(timeout.kind, 'unknown', 'handler-post-dispatch-timeout');
    if (timeout.kind === 'unknown') {
      assert.equal(timeout.reason, 'correlation_mismatch');
      assert.equal(timeout.reportedCode, 'HANDLER_TIMEOUT');
    }
    options.caseExecuted?.('handler-post-dispatch-timeout');
    assertMetadataOnly(readFakeRequests(timeoutState));
    assert.equal(
      readFakeRequests(timeoutState).length,
      1,
      'reconciliation does not retry an uncorrelated watchdog response',
    );

    const reportedConflict = factory({
      ...fake,
      env: { AIZIGN_FAKE_FAULT: 'event-conflict-error' },
      stateDir: join(root, 'reconcile-event-conflict-error'),
      timeoutMs: 10_000,
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
      (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
      'an overlong public field fails before the internal request-bound guard',
    );
    assert.equal(
      existsSync(oversizedInvocationLog),
      false,
      'an invalid overlong source never spawns the fake core',
    );
    assert.equal(
      readFakeRequests(oversizedState).length,
      0,
      'an invalid overlong source never reaches the core',
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The complete language-neutral `CoreClient` scenario set, against the fake
 * core and a supplied production client factory.
 */
export async function runCoreClientConformance(
  factory: CoreClientFactory,
  options: ConformanceOptions = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'aizign-fake-core-command-'));
  try {
    await runCoreScenarios(factory, { command: fakeCoreExecutable(root) }, options);
    await runFaultScenarios(factory, options);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
