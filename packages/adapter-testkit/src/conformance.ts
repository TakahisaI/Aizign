/**
 * The behaviour every adapter's core client must have, proven against the
 * fake core. Call {@link runCoreClientConformance} from the adapter's
 * conformance test with a factory for its client.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  type CoreClient,
  type CoreClientConfig,
  PROTOCOL_VERSION,
  type WorkflowSignalSubmitPayload,
} from '@aizu/protocol';
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
    role: 'implementation',
    artifactRevision: 'rev-a',
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
];

/** Asserts a JSON value carries none of the forbidden keys at any depth. */
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

/** How to reach a core: the fake, or a real `aizu` binary. */
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
  const root = mkdtempSync(join(tmpdir(), 'aizu-core-scenarios-'));
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
  const root = mkdtempSync(join(tmpdir(), 'aizu-fault-scenarios-'));
  try {
    const fake = fakeCoreCommand();
    const make = (name: string, env: Record<string, string>, timeoutMs = 10_000) =>
      factory({ ...fake, env, stateDir: join(root, name), timeoutMs });

    const scenarios: Array<[string, string, string]> = [
      ['no-response', 'no_response', 'process exits without a frame'],
      ['garbage', 'undecodable_response', 'stdout is not a frame'],
      ['journal-unknown', 'reported_unknown', 'the core reports JOURNAL_OUTCOME_UNKNOWN'],
      ['exit-2', 'no_response', 'process fails before answering'],
    ];
    for (const [fault, reason, description] of scenarios) {
      const outcome = await make(`fault-${fault}`, { AIZU_FAKE_FAULT: fault }).submitWorkflowSignal(
        'req-fault',
        samplePayload('evt-fault'),
      );
      assert.equal(outcome.kind, 'unknown', `${description}: ${JSON.stringify(outcome)}`);
      if (outcome.kind === 'unknown') assert.equal(outcome.reason, reason, description);
    }
    const hang = await make(
      'fault-hang',
      { AIZU_FAKE_FAULT: 'hang' },
      options.hangTimeoutMs ?? 500,
    ).submitWorkflowSignal('req-hang', samplePayload('evt-hang'));
    assert.equal(hang.kind, 'unknown');
    if (hang.kind === 'unknown') assert.equal(hang.reason, 'timeout');

    // cancellation: the caller's abort kills the process; the outcome is unknown.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await make('fault-abort', { AIZU_FAKE_FAULT: 'hang' }).submitWorkflowSignal(
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Everything an adapter's core client must satisfy, against the fake core.
 */
export async function runCoreClientConformance(
  factory: CoreClientFactory,
  options: ConformanceOptions = {},
): Promise<void> {
  await runCoreScenarios(factory, fakeCoreCommand());
  await runFaultScenarios(factory, options);
}
