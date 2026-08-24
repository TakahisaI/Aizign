import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SignalBinding } from '../../src/config.ts';
import {
  type EvidenceSource,
  readSignalEvidence,
  type SessionEventLike,
} from '../../src/evidence/cold-read.ts';
import { bindingDigest, canonicalJson, payloadDigest } from '../../src/evidence/digest.ts';
import { presentationMetaFor, TOOL_NAME } from '../../src/mapping/tool.ts';

const binding: SignalBinding = {
  eventId: 'evt-1',
  expected: {
    workflowId: 'wf-1',
    assignmentId: 'as-impl',
    attemptId: 'attempt-impl',
    role: 'implementation',
    artifactRevision: 'rev-a',
    candidateDigest: {
      algorithm: 'sha256',
      hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
};

function source(events: SessionEventLike[]): EvidenceSource {
  return { readFrom: async () => ({ events }) };
}

function call(seq: number, callId: string, args: unknown, name = TOOL_NAME): SessionEventLike {
  return {
    type: 'tool/call',
    seq,
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
  };
}

function result(
  seq: number,
  callId: string,
  meta: unknown,
  error?: { name: string; code: string },
): SessionEventLike {
  return {
    type: 'tool/result',
    seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [] }],
        source: { kind: 'tool', callId },
      },
      ...(error ? { error } : {}),
      meta,
    },
  };
}

test('canonical JSON sorts keys recursively and drops undefined', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 2 }], c: undefined } }),
    '{"a":{"d":[2,{"e":2,"f":1}]},"b":1}',
  );
  assert.equal(bindingDigest(binding), bindingDigest({ ...binding }));
  assert.notEqual(bindingDigest(binding), bindingDigest({ ...binding, eventId: 'evt-2' }));
});

test('a recorded call/result pair with matching event and binding metadata is evidence', async () => {
  const args = { kind: 'implementation_ready' };
  const meta = presentationMetaFor(binding, args, { disposition: 'accepted', eventId: 'evt-1' });
  const evidence = await readSignalEvidence(
    source([call(3, 'c1', args), result(4, 'c1', meta)]),
    'session-x',
    binding,
  );
  assert.deepEqual(evidence, {
    kind: 'accepted',
    eventId: 'evt-1',
    callSeq: 3,
    resultSeq: 4,
    payloadDigest: payloadDigest({
      ...binding.expected,
      eventId: 'evt-1',
      kind: 'implementation_ready',
    }),
  });
});

test('cold-read timing is metadata-only and cannot change evidence', async () => {
  const args = { kind: 'implementation_ready' };
  const meta = presentationMetaFor(binding, args, { disposition: 'accepted', eventId: 'evt-1' });
  const timings: unknown[] = [];
  const evidence = await readSignalEvidence(
    source([call(3, 'c1', args), result(4, 'c1', meta)]),
    'session-sensitive',
    binding,
    {
      timingSink: (measurement) => {
        timings.push(measurement);
      },
    },
  );
  assert.equal(evidence.kind, 'accepted');
  assert.equal(timings.length, 1);
  const timing = timings[0] as Record<string, unknown>;
  assert.equal(timing.operation_kind, 'dsh.evidence.cold_read');
  assert.equal(timing.events_returned, 2);
  assert.equal(timing.outcome, 'accepted');
  assert.equal(typeof timing.harness_cold_read_ms, 'number');
  assert.ok(!JSON.stringify(timing).includes('session-sensitive'));

  const stillAccepted = await readSignalEvidence(
    source([call(3, 'c1', args), result(4, 'c1', meta)]),
    'session-sensitive',
    binding,
    {
      timingSink: async () => {
        throw new Error('timing sink unavailable');
      },
    },
  );
  assert.equal(stillAccepted.kind, 'accepted');
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('a call without a result is unknown, never inferred from later prose', async () => {
  const args = { kind: 'implementation_ready' };
  const evidence = await readSignalEvidence(
    source([call(3, 'c1', args), { type: 'assistant/message', seq: 4, data: { text: 'done!' } }]),
    'session-x',
    binding,
  );
  assert.deepEqual(evidence, { kind: 'unknown', reason: 'no_result', callSeq: 3 });
});

test('results bound to another identity or without our metadata are unknown', async () => {
  const args = { kind: 'implementation_ready' };
  const other = presentationMetaFor({ ...binding, eventId: 'evt-9' }, args, {
    disposition: 'accepted',
    eventId: 'evt-9',
  });
  assert.deepEqual(
    await readSignalEvidence(source([call(1, 'c1', args), result(2, 'c1', other)]), 's', binding),
    { kind: 'unknown', reason: 'meta_mismatch', callSeq: 1 },
  );
  assert.deepEqual(
    await readSignalEvidence(
      source([call(1, 'c1', args), result(2, 'c1', { unrelated: true })]),
      's',
      binding,
    ),
    { kind: 'unknown', reason: 'meta_mismatch', callSeq: 1 },
  );
});

test('an error result is unknown, never a binding-attributed rejection (#32)', async () => {
  const args = { kind: 'implementation_ready' };
  const events = [
    call(1, 'other', { x: 1 }, 'some_other_tool'),
    result(2, 'other', { tool: 'some_other_tool' }),
    call(3, 'c1', args),
    result(4, 'c1', undefined, { name: 'HarnessError', code: 'EVENT_CONFLICT' }),
  ];
  // Even under the binding that made the call: the error carries no metadata.
  assert.deepEqual(await readSignalEvidence(source(events), 's', binding), {
    kind: 'unknown',
    reason: 'unverified_error',
    code: 'EVENT_CONFLICT',
    callSeq: 3,
    resultSeq: 4,
  });
  // A cold read under a different binding (other eventId / assignment /
  // revision) must not adopt the old error as its own rejection.
  const rebound = {
    ...binding,
    eventId: 'evt-other',
    expected: { ...binding.expected, artifactRevision: 'rev-other' },
  };
  const relabeled = await readSignalEvidence(source(events), 's', rebound);
  assert.equal(relabeled.kind, 'unknown');
  assert.deepEqual(await readSignalEvidence(source(events.slice(0, 2)), 's', binding), {
    kind: 'absent',
  });
});

test('caller timeout and the post-read event guard are unknown, never partial', async () => {
  const args = { kind: 'implementation_ready' };
  const meta = presentationMetaFor(binding, args, { disposition: 'accepted', eventId: 'evt-1' });
  const events = [call(1, 'c1', args), result(2, 'c1', meta)];
  const bounded = await readSignalEvidence(source(events), 's', binding, { maxEvents: 1 });
  assert.deepEqual(bounded, {
    kind: 'unknown',
    reason: 'bound_exceeded',
    detail: 'session returned 2 events; at most 1 are read',
  });

  const slow: EvidenceSource = { readFrom: () => new Promise(() => undefined) };
  const timedOut = await readSignalEvidence(slow, 's', binding, { timeoutMs: 50 });
  assert.deepEqual(timedOut, { kind: 'unknown', reason: 'aborted', detail: 'cold read timed out' });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const cancelled = await readSignalEvidence(slow, 's', binding, { signal: controller.signal });
  assert.deepEqual(cancelled, {
    kind: 'unknown',
    reason: 'aborted',
    detail: 'cold read cancelled',
  });

  // The signal is forwarded to the source, as DSH's readFrom expects.
  let forwarded: AbortSignal | undefined;
  const observing: EvidenceSource = {
    readFrom: async (_id: string, _from: number, signal?: AbortSignal) => {
      forwarded = signal;
      return { events };
    },
  };
  await readSignalEvidence(observing, 's', binding, { fromSeq: 1 });
  assert.ok(forwarded instanceof AbortSignal);
});
