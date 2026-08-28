import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeRequest } from './envelope.ts';
import { codes, ProtocolError } from './error.ts';
import {
  decodeReconciliationResult,
  decodeWorkflowSignalReconcile,
  decodeWorkflowSignalSubmit,
} from './workflow-signal.ts';

const validDigest = {
  algorithm: 'sha256',
  hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

test('invalid expected candidate digest has a digest-specific diagnostic', () => {
  assert.throws(
    () =>
      decodeWorkflowSignalSubmit({
        expected: {
          workflowId: 'wf-1',
          assignmentId: 'as-1',
          attemptId: 'attempt-1',
          role: 'implementation',
          artifactRevision: 'rev-1',
          candidateDigest: { algorithm: 'sha256', hex: 'ABC' },
        },
        signal: {
          eventId: 'evt-1',
          workflowId: 'wf-1',
          assignmentId: 'as-1',
          attemptId: 'attempt-1',
          role: 'implementation',
          artifactRevision: 'rev-1',
          candidateDigest: validDigest,
          kind: 'implementation_ready',
        },
      }),
    (error: unknown) =>
      error instanceof ProtocolError &&
      error.code === codes.INVALID_EXPECTATION &&
      error.message === 'expected.candidateDigest: not a supported content digest',
  );
});

test('reconciliation reuses the exact signal contract without expected', () => {
  const signal = {
    eventId: 'evt-1',
    workflowId: 'wf-1',
    assignmentId: 'as-1',
    attemptId: 'attempt-1',
    role: 'implementation',
    artifactRevision: 'rev-1',
    candidateDigest: validDigest,
    kind: 'implementation_ready',
  } as const;
  const decoded = decodeWorkflowSignalReconcile({ signal });
  const encoded = JSON.parse(
    encodeRequest({
      requestId: 'req-reconcile-helper-boundary',
      kind: 'workflow.signal.reconcile',
      payload: decoded,
    }),
  ) as { payload: unknown };
  assert.deepEqual(encoded.payload, { signal }, 'payload encoding stays behind encodeRequest');

  assert.throws(
    () =>
      decodeWorkflowSignalReconcile({
        signal: { ...signal, workflowId: 'bad id' },
      }),
    (error: unknown) =>
      error instanceof ProtocolError &&
      error.code === codes.INVALID_SIGNAL &&
      error.message.startsWith('signal.workflowId:'),
  );

  for (const invalid of [
    { ...signal, workflowId: 7 },
    { ...signal, candidateDigest: { algorithm: 'sha256', hex: 'ABC' } },
    { ...signal, artifactRef: null },
  ]) {
    assert.throws(
      () => decodeWorkflowSignalReconcile({ signal: invalid }),
      (error: unknown) =>
        error instanceof ProtocolError &&
        !error.message.includes('expected.') &&
        error.message.includes('signal.'),
    );
  }
});

test('reconciliation result accepts only accepted, conflict, or absent', () => {
  for (const disposition of ['accepted', 'conflict', 'absent'] as const) {
    assert.deepEqual(decodeReconciliationResult({ disposition, eventId: 'evt-1' }), {
      disposition,
      eventId: 'evt-1',
    });
  }
  assert.throws(
    () =>
      decodeReconciliationResult({
        disposition: 'duplicate',
        eventId: 'evt-1',
      }),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_PAYLOAD,
  );
});

test('outbound signal validation uses only own data properties without invoking getters', () => {
  const signal = {
    eventId: 'evt-1',
    workflowId: 'wf-1',
    assignmentId: 'as-1',
    attemptId: 'attempt-1',
    role: 'implementation',
    artifactRevision: 'rev-1',
    candidateDigest: validDigest,
    kind: 'implementation_ready',
  } as const;
  const inheritedValues = {
    eventId: 'evt-inherited',
    expected: {},
    signal,
    findingCount: 1,
    artifactRef: 'artifact:inherited',
  };
  for (const [key, inherited] of Object.entries(inheritedValues)) {
    let calls = 0;
    const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      get: () => {
        calls += 1;
        return inherited;
      },
    });
    try {
      if (key === 'eventId') {
        const { eventId: _eventId, ...missingEventId } = signal;
        assert.throws(() => decodeWorkflowSignalReconcile({ signal: missingEventId }));
      } else if (key === 'expected') {
        assert.throws(() => decodeWorkflowSignalSubmit({ signal }));
      } else if (key === 'signal') {
        assert.throws(() => decodeWorkflowSignalReconcile({}));
      } else {
        assert.doesNotThrow(() => decodeWorkflowSignalReconcile({ signal }));
      }
      assert.equal(calls, 0, `${key} getter was invoked`);
    } finally {
      if (original === undefined) delete (Object.prototype as Record<string, unknown>)[key];
      else Object.defineProperty(Object.prototype, key, original);
    }
  }
});

test('present undefined optionals and negative zero are rejected', () => {
  const base = {
    eventId: 'evt-1',
    workflowId: 'wf-1',
    assignmentId: 'as-1',
    attemptId: 'attempt-1',
    role: 'review',
    artifactRevision: 'rev-1',
    candidateDigest: validDigest,
    kind: 'review_passed',
  } as const;
  assert.throws(
    () =>
      decodeWorkflowSignalReconcile({
        signal: { ...base, artifactRef: undefined },
      }),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_PAYLOAD,
  );
  assert.throws(
    () => decodeWorkflowSignalReconcile({ signal: { ...base, findingCount: -0 } }),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_PAYLOAD,
  );
});
