/**
 * End to end without a live harness: fake DSH runtime → plugin → core →
 * journal → result → session log → cold read. Runs against the fake core
 * always, and against the real `aizign` binary when `AIZIGN_BINARY` is set.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertMetadataOnly, readFakeRequests } from '@aizign/adapter-testkit';
import type { Config } from '../../src/config.ts';
import { readSignalEvidence } from '../../src/evidence/cold-read.ts';
import { apply, codes, TOOL_NAME } from '../../src/index.ts';
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
  };
}

const binding = {
  eventId: 'evt-round-trip',
  expected: {
    workflowId: 'wf-round-trip',
    assignmentId: 'as-implementation',
    attemptId: 'attempt-round-trip',
    role: 'implementation',
    artifactRevision: 'rev-a',
    candidateDigest: {
      algorithm: 'sha256',
      hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
} as const;

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
      for (const forbidden of [dsh.sessionId, 'call_0001', 'sessionId', 'callId', 'prompt']) {
        assert.ok(!journal.includes(forbidden), `journal must not contain ${forbidden}`);
      }
      assertMetadataOnly(JSON.parse(journal.trim()));
    }

    // duplicate, then conflict, through the same plugin instance.
    const again = await dsh.dispatch(TOOL_NAME, { kind: 'implementation_ready' });
    assert.deepEqual(again.value, { disposition: 'duplicate', eventId: 'evt-round-trip' });
    const conflict = await dsh.dispatch(TOOL_NAME, {
      kind: 'blocked',
      shortErrorCode: 'CHANGED_MY_MIND',
    });
    assert.equal(conflict.error?.code, 'EVENT_CONFLICT');

    // restart: a fresh harness and plugin instance, same state directory.
    const restarted = new FakeDsh();
    await apply(restarted.context, config(binary, stateDir));
    const afterRestart = await restarted.dispatch(TOOL_NAME, { kind: 'implementation_ready' });
    assert.deepEqual(afterRestart.value, { disposition: 'duplicate', eventId: 'evt-round-trip' });

    // cold read of the durable session log: the latest call settled as a duplicate.
    const evidence = await readSignalEvidence(restarted, restarted.sessionId, binding);
    assert.equal(evidence.kind, 'duplicate');
    if (evidence.kind === 'duplicate') assert.equal(evidence.eventId, 'evt-round-trip');
    const original = await readSignalEvidence(dsh, dsh.sessionId, binding);
    assert.equal(original.kind, 'unknown', 'the first session ended with an unverifiable error');
    if (original.kind === 'unknown' && original.reason === 'unverified_error') {
      assert.equal(original.code, 'EVENT_CONFLICT');
    } else {
      assert.fail('expected an unverified_error evidence entry');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('fake DSH → plugin → fake core → result → cold read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-fake-binary-'));
  try {
    await roundTrip(fakeBinary(root), 'fake-journal.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const binary = process.env.AIZIGN_BINARY;
test('fake DSH → plugin → real aizign binary → JSONL journal → cold read', {
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
    const crashing = fakeBinary(join(root, 'crash'), { AIZIGN_FAKE_FAULT: 'no-response' });
    const crashedDsh = new FakeDsh();
    // preflight hello also gets no response → fail closed, no tool.
    await assert.rejects(apply(crashedDsh.context, config(crashing, stateDir)));
    assert.equal(crashedDsh.registered.length, 0);

    // Now a core that answers hello but reports an unknown journal outcome.
    const unknownDsh = new FakeDsh();
    await apply(
      unknownDsh.context,
      config(fakeBinary(join(root, 'unknown'), { AIZIGN_FAKE_FAULT: 'journal-unknown' }), stateDir),
    );
    const outcome = await unknownDsh.dispatch(TOOL_NAME, { kind: 'implementation_ready' });
    assert.equal(outcome.error?.code, codes.OUTCOME_UNKNOWN);
    const requests = readFileSync(join(stateDir, 'fake-requests.jsonl'), 'utf8').trim().split('\n');
    assert.equal(requests.length, 1, 'exactly one submission; unknown is never retried');

    const evidence = await readSignalEvidence(unknownDsh, unknownDsh.sessionId, binding);
    assert.equal(evidence.kind, 'unknown');
    if (evidence.kind === 'unknown' && evidence.reason === 'unverified_error') {
      assert.equal(evidence.code, codes.OUTCOME_UNKNOWN);
    } else {
      assert.fail('expected an unverified_error evidence entry');
    }
    assert.ok(
      !existsSync(join(stateDir, 'workflow.jsonl')),
      'the fake core writes its own state file',
    );

    // Nothing harness-specific crossed the boundary: not in the payload, not in the envelope.
    for (const envelope of readFakeRequests(stateDir)) {
      assertMetadataOnly(envelope);
      const text = JSON.stringify(envelope);
      assert.ok(!text.includes(unknownDsh.sessionId), 'session id must not reach the core');
      assert.ok(!text.includes('call_0001'), 'call id must not reach the core');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
