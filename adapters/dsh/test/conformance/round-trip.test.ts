/**
 * End to end without a live harness: fake DSH runtime → plugin → core →
 * journal → result. Runs against the fake core always, and against the real
 * `aizign` binary when `AIZIGN_BINARY` is set.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertMetadataOnly, readFakeRequests } from '@aizign/adapter-testkit';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Config } from '../../src/config.ts';
import { apply } from '../../src/index.ts';
import { adapterCodes as codes, TOOL_NAME } from '../../src/mapping/tool.ts';
import { FakeDsh, fakeBinary } from '../helpers/fake-dsh.ts';

function config(binary: string, stateDir: string): Config {
  return {
    binary,
    stateDir,
    eventId: 'evt-round-trip',
    workflowId: 'wf-round-trip',
    assignmentId: 'as-implementation',
    attemptId: 'attempt-round-trip',
    role: 'implementation',
    artifactRevision: 'rev-a',
    candidateDigest: {
      algorithm: 'sha256',
      hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    trustedSignalValues: {
      artifactRef: 'artifact:round-trip',
      blockedShortErrorCode: 'CHANGED_MY_MIND',
    },
  };
}

async function roundTrip(binary: string, journalFile: string | undefined): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-round-trip-'));
  try {
    const stateDir = join(root, 'state');
    const dsh = new FakeDsh();
    await apply(dsh.context, config(binary, stateDir));
    assert.equal(dsh.registered.length, 1);

    // accepted: the journal, not the tool result, is what makes it so.
    const first = await dsh.dispatch(TOOL_NAME, { kind: 'implementation_ready' });
    assert.deepEqual(first.value, { disposition: 'accepted', eventId: 'evt-round-trip' });
    if (journalFile !== undefined) {
      const journal = readFileSync(join(stateDir, journalFile), 'utf8');
      assert.equal(journal.trim().split('\n').length, 1, 'exactly one durable record');
      for (const forbidden of ['call_0001', 'sessionId', 'callId', 'prompt']) {
        assert.ok(!journal.includes(forbidden), `journal must not contain ${forbidden}`);
      }
      assertMetadataOnly(JSON.parse(journal.trim()));
    }

    // duplicate, then conflict, through the same plugin instance.
    const again = await dsh.dispatch(TOOL_NAME, { kind: 'implementation_ready' });
    assert.deepEqual(again.value, { disposition: 'duplicate', eventId: 'evt-round-trip' });
    const conflict = await dsh.dispatch(TOOL_NAME, {
      kind: 'blocked',
    });
    assert.equal(conflict.error?.code, 'EVENT_CONFLICT');

    // restart: a fresh harness and plugin instance, same state directory.
    const restarted = new FakeDsh();
    await apply(restarted.context, config(binary, stateDir));
    const afterRestart = await restarted.dispatch(TOOL_NAME, { kind: 'implementation_ready' });
    assert.deepEqual(afterRestart.value, { disposition: 'duplicate', eventId: 'evt-round-trip' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('fake DSH → plugin → fake core → result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-fake-binary-'));
  try {
    await roundTrip(fakeBinary(root), 'fake-journal.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fake DSH maps a local Protocol source failure without invoking the core', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-local-failure-'));
  try {
    const stateDir = join(root, 'state');
    const invocationLog = join(root, 'invocations.log');
    const dsh = new FakeDsh();
    await apply(dsh.context, config(fakeBinary(join(root, 'bin'), { invocationLog }), stateDir));
    const before = readFileSync(invocationLog, 'utf8').trim().split('\n').length;
    const cases = [
      {
        arguments: {
          kind: 'blocked',
          shortErrorCode: 'credential-synthetic-user-password-private-canary',
        },
        canary: 'credential-synthetic-user-password-private-canary',
      },
      {
        arguments: {
          kind: 'repair_submitted',
          artifactRef: 'ZW5jb2RlZC1wcml2YXRlLWNvbnRlbnQ=',
        },
        canary: 'ZW5jb2RlZC1wcml2YXRlLWNvbnRlbnQ=',
      },
    ] as const;
    for (const { arguments: arguments_, canary } of cases) {
      const exec = {
        callId: 'private-call-canary',
        signal: new AbortController().signal,
      } as unknown as ToolRunContext;
      await assert.rejects(dsh.tool(TOOL_NAME).execute(arguments_, exec), (error: unknown) => {
        const snapshot = Object.fromEntries(
          error instanceof Error
            ? Reflect.ownKeys(error).map((key) => [
                typeof key === 'symbol' ? key.toString() : key,
                Reflect.getOwnPropertyDescriptor(error, key)?.value,
              ])
            : [],
        );
        return (
          error instanceof HarnessError &&
          error.code === 'INVALID_SIGNAL' &&
          error.message === 'Aizign rejected invalid workflow signal input' &&
          !('cause' in error) &&
          !String(error.stack).includes(canary) &&
          !JSON.stringify(snapshot).includes(canary)
        );
      });
      const outcome = await dsh.dispatch(TOOL_NAME, arguments_);
      assert.equal(outcome.error?.code, 'INVALID_SIGNAL');
      assert.ok(!JSON.stringify(outcome).includes(canary));
    }
    const after = readFileSync(invocationLog, 'utf8').trim().split('\n').length;
    assert.equal(after, before, 'local Protocol failure must not spawn a submit process');
    for (const { canary } of cases) {
      assert.ok(!readFileSync(invocationLog, 'utf8').includes(canary));
    }
    assert.equal(existsSync(join(stateDir, 'fake-requests.jsonl')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const binary = process.env.AIZIGN_BINARY;
test('fake DSH → plugin → real aizign binary → JSONL journal', {
  skip: binary === undefined ? 'set AIZIGN_BINARY to a built aizign binary' : false,
}, async () => {
  await roundTrip(binary ?? '', 'workflow.jsonl');
});

test('a crashed core leaves an unknown outcome, one submission, and no inferred success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-crash-'));
  try {
    const stateDir = join(root, 'state');
    const dsh = new FakeDsh();
    // The handshake must succeed; only the submission is sabotaged.
    await apply(dsh.context, config(fakeBinary(join(root, 'ok')), stateDir));
    const crashing = fakeBinary(join(root, 'crash'), { fault: 'no-response' });
    const crashedDsh = new FakeDsh();
    // preflight hello also gets no response → fail closed, no tool.
    await assert.rejects(apply(crashedDsh.context, config(crashing, stateDir)));
    assert.equal(crashedDsh.registered.length, 0);

    // Now a core that answers hello but reports an unknown journal outcome.
    const unknownDsh = new FakeDsh();
    await apply(
      unknownDsh.context,
      config(fakeBinary(join(root, 'unknown'), { fault: 'journal-unknown' }), stateDir),
    );
    const outcome = await unknownDsh.dispatch(TOOL_NAME, { kind: 'implementation_ready' });
    assert.equal(outcome.error?.code, codes.OUTCOME_UNKNOWN);
    const requests = readFileSync(join(stateDir, 'fake-requests.jsonl'), 'utf8').trim().split('\n');
    assert.equal(requests.length, 1, 'exactly one submission; unknown is never retried');

    assert.ok(
      !existsSync(join(stateDir, 'workflow.jsonl')),
      'the fake core writes its own state file',
    );

    // Nothing harness-specific crossed the boundary: not in the payload, not in the envelope.
    for (const envelope of readFakeRequests(stateDir)) {
      assertMetadataOnly(envelope);
      const text = JSON.stringify(envelope);
      assert.ok(!text.includes('dsh-session-0001'), 'session id must not reach the core');
      assert.ok(!text.includes('call_0001'), 'call id must not reach the core');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
