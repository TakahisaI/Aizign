import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codes, ProtocolError } from './error.ts';
import { decodeWorkflowSignalSubmit } from './workflow-signal.ts';

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
