/**
 * Decoder-independent encoder coverage against every Protocol v1 example.
 *
 * Examples are loaded only as generic JSON values for expected output.
 * Outbound values are constructed directly and passed to the production
 * encoders. `spec/test/schema.test.mjs` validates the same examples, so JSON
 * value equality keeps schema validation in the existing repository gate.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findInvalidUnicode } from './duplicate-member.ts';
import {
  encodeRequest,
  encodeResponse,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BYTES,
  type Request,
  type Response,
} from './envelope.ts';
import { codes, ProtocolError } from './error.ts';
import {
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  type HelloInfo,
} from './hello.ts';
import type { ExpectedAssignment, WorkflowSignal } from './workflow-signal.ts';

const root = join(import.meta.dirname, '../../../spec/protocol/v1/examples');
const encoder = new TextEncoder();
const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);

function example(name: string): unknown {
  return JSON.parse(readFileSync(join(root, name), 'utf8'));
}

function exampleNames(suffix: string): string[] {
  const names = readdirSync(root)
    .filter((name) => name.endsWith(suffix))
    .sort();
  assert.ok(names.length > 0, `no examples ending in ${suffix}`);
  return names;
}

function assertExplicitCoverage<T>(
  suffix: string,
  cases: ReadonlyArray<readonly [string, T]>,
): void {
  assert.deepEqual(
    cases.map(([name]) => name),
    exampleNames(suffix),
    'every Protocol v1 example must have an explicit encoder case',
  );
}

function assertFrame(name: string, frame: string, bound: number): void {
  const bytes = encoder.encode(frame);
  assert.ok(bytes.byteLength <= bound, `${name}: encoded frame exceeds ${bound} bytes`);
  assert.notDeepEqual(
    [...bytes.slice(0, 3)],
    [0xef, 0xbb, 0xbf],
    `${name}: frame must not start with a UTF-8 BOM`,
  );
  assert.equal(frame.includes('\n'), false, `${name}: frame contains a raw newline`);
  assert.equal(frame.includes('\r'), false, `${name}: frame contains a raw carriage return`);
  assert.equal(frame.trim(), frame, `${name}: frame contains surrounding whitespace`);
  assert.equal(findInvalidUnicode(frame), null, `${name}: frame contains ill-formed Unicode`);

  const encoded: unknown = JSON.parse(frame);
  assert.ok(typeof encoded === 'object' && encoded !== null && !Array.isArray(encoded), name);
  assert.deepEqual(encoded, example(name), `${name}: JSON value`);
}

function expectedAssignment(): ExpectedAssignment {
  return {
    workflowId: 'wf-example-01',
    assignmentId: 'as-implementation-01',
    attemptId: 'attempt-fixture',
    role: 'implementation',
    artifactRevision: 'rev-c0ffee',
    candidateDigest: { algorithm: 'sha256', hex: SHA256_A },
  };
}

function reviewExpectedAssignment(): ExpectedAssignment {
  return {
    workflowId: 'wf-example-01',
    assignmentId: 'as-review-01',
    attemptId: 'attempt-fixture',
    role: 'review',
    artifactRevision: 'rev-c0ffee',
    candidateDigest: { algorithm: 'sha256', hex: SHA256_A },
  };
}

function implementationReady(eventId: string): WorkflowSignal {
  return {
    eventId,
    workflowId: 'wf-example-01',
    assignmentId: 'as-implementation-01',
    attemptId: 'attempt-fixture',
    role: 'implementation',
    artifactRevision: 'rev-c0ffee',
    candidateDigest: { algorithm: 'sha256', hex: SHA256_A },
    kind: 'implementation_ready',
  };
}

function blocked(eventId: string): WorkflowSignal {
  return {
    ...implementationReady(eventId),
    kind: 'blocked',
    shortErrorCode: 'TOOL_UNAVAILABLE',
  };
}

function reviewFindings(eventId: string): WorkflowSignal {
  return {
    eventId,
    workflowId: 'wf-example-01',
    assignmentId: 'as-review-01',
    attemptId: 'attempt-fixture',
    role: 'review',
    artifactRevision: 'rev-c0ffee',
    candidateDigest: { algorithm: 'sha256', hex: SHA256_A },
    kind: 'review_findings',
    findingCount: 2,
    artifactRef: 'review:0123456789abcdef',
  };
}

function reviewPassed(eventId: string): WorkflowSignal {
  return {
    eventId,
    workflowId: 'wf-example-01',
    assignmentId: 'as-review-01',
    attemptId: 'attempt-fixture',
    role: 'review',
    artifactRevision: 'rev-c0ffee',
    candidateDigest: { algorithm: 'sha256', hex: SHA256_A },
    kind: 'review_passed',
    findingCount: 0,
  };
}

function repairSubmitted(eventId: string): WorkflowSignal {
  return {
    ...implementationReady(eventId),
    kind: 'repair_submitted',
    findingCount: 1,
    artifactRef: 'repair:0123456789abcdef',
  };
}

function submitRequest(
  requestId: string,
  expected: ExpectedAssignment,
  signal: WorkflowSignal,
): Request {
  return {
    requestId,
    kind: 'workflow.signal.submit',
    payload: { expected, signal },
  };
}

function response(requestId: string | null, kind: string | null, body: Response['body']): Response {
  return { requestId, kind, body };
}

test('request encoders match every Protocol v1 example without decoding', () => {
  const cases = [
    ['hello.request.json', { requestId: 'req-hello-01', kind: 'hello' }],
    [
      'workflow-signal-reconcile.request.json',
      {
        requestId: 'req-reconcile-01',
        kind: 'workflow.signal.reconcile',
        payload: { signal: implementationReady('evt-0001') },
      },
    ],
    [
      'workflow-signal-submit.blocked.request.json',
      submitRequest('req-signal-03', expectedAssignment(), blocked('evt-0003')),
    ],
    [
      'workflow-signal-submit.request.json',
      submitRequest('req-signal-01', expectedAssignment(), implementationReady('evt-0001')),
    ],
    [
      'workflow-signal-submit.review-findings.request.json',
      submitRequest('req-signal-02', reviewExpectedAssignment(), reviewFindings('evt-0002')),
    ],
  ] as const satisfies ReadonlyArray<readonly [string, Request]>;
  assertExplicitCoverage('.request.json', cases);

  for (const [name, request] of cases) {
    assertFrame(name, encodeRequest(request), MAX_REQUEST_BYTES);
  }
});

test('submit request encoder preserves expected and signal field provenance', () => {
  const expected: ExpectedAssignment = {
    workflowId: 'wf-expected',
    assignmentId: 'as-expected',
    attemptId: 'attempt-expected',
    role: 'review',
    artifactRevision: 'rev-expected',
    candidateDigest: { algorithm: 'sha256', hex: SHA256_B },
  };
  const signal: WorkflowSignal = {
    eventId: 'evt-provenance',
    workflowId: 'wf-signal',
    assignmentId: 'as-signal',
    attemptId: 'attempt-signal',
    role: 'implementation',
    artifactRevision: 'rev-signal',
    candidateDigest: { algorithm: 'sha256', hex: SHA256_A },
    kind: 'implementation_ready',
  };
  const frame = encodeRequest(submitRequest('req-provenance', expected, signal));
  const encoded = JSON.parse(frame) as { payload: unknown };

  assert.deepEqual(encoded.payload, { expected, signal });
});

test('request encoder covers every workflow signal kind and its optional fields', () => {
  const cases = [
    {
      signal: implementationReady('evt-kind-01'),
      findingCount: undefined,
      artifactRef: undefined,
      shortErrorCode: undefined,
    },
    {
      signal: reviewFindings('evt-kind-02'),
      findingCount: 2,
      artifactRef: 'review:0123456789abcdef',
      shortErrorCode: undefined,
    },
    {
      signal: reviewPassed('evt-kind-03'),
      findingCount: 0,
      artifactRef: undefined,
      shortErrorCode: undefined,
    },
    {
      signal: repairSubmitted('evt-kind-04'),
      findingCount: 1,
      artifactRef: 'repair:0123456789abcdef',
      shortErrorCode: undefined,
    },
    {
      signal: blocked('evt-kind-05'),
      findingCount: undefined,
      artifactRef: undefined,
      shortErrorCode: 'TOOL_UNAVAILABLE',
    },
  ] as const;

  for (const { signal, findingCount, artifactRef, shortErrorCode } of cases) {
    const frame = encodeRequest({
      requestId: `req-${signal.kind}`,
      kind: 'workflow.signal.reconcile',
      payload: { signal },
    });
    const encoded = JSON.parse(frame) as {
      payload: { signal: Record<string, unknown> };
    };
    const wireSignal = encoded.payload.signal;
    assert.equal(wireSignal.kind, signal.kind);
    assert.equal(wireSignal.findingCount, findingCount);
    assert.equal(wireSignal.artifactRef, artifactRef);
    assert.equal(wireSignal.shortErrorCode, shortErrorCode);
    assert.equal(
      Object.keys(wireSignal).length,
      8 +
        Number(findingCount !== undefined) +
        Number(artifactRef !== undefined) +
        Number(shortErrorCode !== undefined),
      `${signal.kind}: unexpected signal fields`,
    );
  }
});

test('response encoders match every Protocol v1 example without decoding', () => {
  const hello: HelloInfo = {
    protocolVersion: 1,
    journalSchemaVersion: 1,
    capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT, CAPABILITY_WORKFLOW_SIGNAL_RECONCILE],
    package: { name: 'aizign', version: '0.1.0' },
  };
  const cases = [
    ['hello.response.json', response('req-hello-01', 'hello', { type: 'hello', info: hello })],
    [
      'invalid-envelope.response.json',
      response(null, null, {
        type: 'error',
        error: new ProtocolError(codes.INVALID_ENVELOPE, 'expected value at line 1 column 1'),
      }),
    ],
    [
      'version-unsupported.response.json',
      response('req-future-01', 'hello', {
        type: 'error',
        error: new ProtocolError(
          codes.PROTOCOL_VERSION_UNSUPPORTED,
          'protocol version 2 is not supported; this binary speaks 1',
        ),
      }),
    ],
    [
      'workflow-signal-reconcile.absent.response.json',
      response('req-reconcile-01', 'workflow.signal.reconcile', {
        type: 'workflow.signal.reconciliation',
        result: { disposition: 'absent', eventId: 'evt-0001' },
      }),
    ],
    [
      'workflow-signal-reconcile.accepted.response.json',
      response('req-reconcile-01', 'workflow.signal.reconcile', {
        type: 'workflow.signal.reconciliation',
        result: { disposition: 'accepted', eventId: 'evt-0001' },
      }),
    ],
    [
      'workflow-signal-reconcile.conflict.response.json',
      response('req-reconcile-01', 'workflow.signal.reconcile', {
        type: 'workflow.signal.reconciliation',
        result: { disposition: 'conflict', eventId: 'evt-0001' },
      }),
    ],
    [
      'workflow-signal-submit.accepted.response.json',
      response('req-signal-01', 'workflow.signal.submit', {
        type: 'workflow.signal',
        result: { disposition: 'accepted', eventId: 'evt-0001' },
      }),
    ],
    [
      'workflow-signal-submit.duplicate.response.json',
      response('req-signal-01', 'workflow.signal.submit', {
        type: 'workflow.signal',
        result: { disposition: 'duplicate', eventId: 'evt-0001' },
      }),
    ],
    [
      'workflow-signal-submit.rejected.response.json',
      response('req-signal-01', 'workflow.signal.submit', {
        type: 'error',
        error: new ProtocolError(
          'REVISION_MISMATCH',
          'revision mismatch: expected rev-c0ffee, got rev-deadbeef',
        ),
      }),
    ],
  ] as const satisfies ReadonlyArray<readonly [string, Response]>;
  assertExplicitCoverage('.response.json', cases);

  for (const [name, value] of cases) {
    assertFrame(name, encodeResponse(value), MAX_FRAME_BYTES);
  }
});

test('response encoder preserves event id provenance', () => {
  const cases = [
    [
      response('req-submit-provenance', 'workflow.signal.submit', {
        type: 'workflow.signal',
        result: { disposition: 'accepted', eventId: 'evt-submit-provenance' },
      }),
      'evt-submit-provenance',
    ],
    [
      response('req-reconcile-provenance', 'workflow.signal.reconcile', {
        type: 'workflow.signal.reconciliation',
        result: { disposition: 'conflict', eventId: 'evt-reconcile-provenance' },
      }),
      'evt-reconcile-provenance',
    ],
  ] as const satisfies ReadonlyArray<readonly [Response, string]>;

  for (const [value, expectedEventId] of cases) {
    const encoded = JSON.parse(encodeResponse(value)) as {
      payload: { eventId: unknown };
    };
    assert.equal(encoded.payload.eventId, expectedEventId);
  }
});
