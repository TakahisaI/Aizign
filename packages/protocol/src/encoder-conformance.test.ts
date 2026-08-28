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
import { scanJsonTokens } from './json-token.ts';
import type { ExpectedAssignment, WorkflowSignal } from './workflow-signal.ts';

const root = join(import.meta.dirname, '../../../spec/protocol/v1/examples');
const encoder = new TextEncoder();
const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);

test('production encoders depend on package-internal builders, not public decoders', () => {
  const source = readFileSync(join(import.meta.dirname, 'envelope.ts'), 'utf8');
  assert.doesNotMatch(
    source,
    /\bdecode(?:HelloInfo|WorkflowSignalSubmit|WorkflowSignalReconcile|SignalResult|ReconciliationResult)\b/,
  );
});

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
  const scan = scanJsonTokens(frame);
  assert.equal(scan.syntaxError, null, `${name}: frame has invalid JSON grammar`);
  assert.equal(scan.failure, null, `${name}: frame has a lexical defect`);

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
  const version =
    body.type === 'hello' || kind === null || kind === 'hello'
      ? { axis: 'bootstrap' as const, version: 1 }
      : { axis: 'accepted-operation' as const, version: 1 };
  return { version, requestId, kind, body };
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
        result: {
          disposition: 'conflict',
          eventId: 'evt-reconcile-provenance',
        },
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

test('response encoder checks success kind membership before body mapping', () => {
  const hello: HelloInfo = {
    protocolVersion: 1,
    journalSchemaVersion: 1,
    capabilities: [],
    package: { name: 'aizign', version: '0.1.0' },
  };
  const successBodies: readonly Response['body'][] = [
    { type: 'hello', info: hello },
    {
      type: 'workflow.signal',
      result: { disposition: 'accepted', eventId: 'evt-future-submit' },
    },
    {
      type: 'workflow.signal.reconciliation',
      result: { disposition: 'absent', eventId: 'evt-future-reconcile' },
    },
  ];
  for (const body of successBodies) {
    assert.throws(
      () =>
        encodeResponse({
          version: { axis: 'bootstrap', version: 7 },
          requestId: 'req-future-success',
          kind: 'future.operation',
          body,
        }),
      (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
      `${body.type}: invalid bootstrap context`,
    );
    assert.throws(
      () =>
        encodeResponse({
          version: { axis: 'accepted-operation', version: 1 },
          requestId: 'req-future-success',
          kind: 'future.operation',
          body,
        }),
      (error: unknown) => error instanceof ProtocolError && error.code === codes.UNKNOWN_KIND,
      body.type,
    );
  }

  assert.throws(
    () =>
      encodeResponse({
        version: { axis: 'accepted-operation', version: 1 },
        requestId: 'req-wrong-success',
        kind: 'workflow.signal.reconcile',
        body: {
          type: 'workflow.signal',
          result: { disposition: 'accepted', eventId: 'evt-wrong-success' },
        },
      }),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
  );
  assert.throws(
    () =>
      encodeResponse({
        version: { axis: 'bootstrap', version: 1 },
        requestId: 'req-null-success',
        kind: null,
        body: { type: 'hello', info: hello },
      }),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
  );
});

test('outbound source validation rejects hostile descriptors and prototypes without executing them', () => {
  const invalidEnvelope = (error: unknown) =>
    error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE;
  let getterCalls = 0;
  let toJsonCalls = 0;

  const accessorRequest = Object.defineProperty({ kind: 'hello' }, 'requestId', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return 'req-accessor';
    },
  }) as Request;
  assert.throws(() => encodeRequest(accessorRequest), invalidEnvelope);
  assert.equal(getterCalls, 0);

  const nonEnumerable = {};
  Object.defineProperties(nonEnumerable, {
    requestId: { value: 'req-hidden', enumerable: false },
    kind: { value: 'hello', enumerable: false },
  });
  assert.equal(
    encodeRequest(nonEnumerable as Request),
    encodeRequest({ requestId: 'req-hidden', kind: 'hello' }),
  );

  const unknownNonEnumerable = { requestId: 'req-hidden-unknown', kind: 'hello' };
  Object.defineProperty(unknownNonEnumerable, 'hidden', {
    value: true,
    enumerable: false,
  });
  assert.throws(() => encodeRequest(unknownNonEnumerable as Request), invalidEnvelope);

  const hiddenCapabilities = [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT];
  Object.defineProperty(hiddenCapabilities, '0', {
    value: CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
    enumerable: false,
  });
  const hiddenCapabilityResponse: Response = {
    version: { axis: 'bootstrap', version: 1 },
    requestId: 'req-hidden-index',
    kind: 'hello',
    body: {
      type: 'hello',
      info: {
        protocolVersion: 1,
        journalSchemaVersion: 1,
        capabilities: hiddenCapabilities,
        package: { name: 'aizign', version: '0.1.0' },
      },
    },
  };
  assert.deepEqual(
    (JSON.parse(encodeResponse(hiddenCapabilityResponse)) as { payload: HelloInfo }).payload
      .capabilities,
    [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
  );

  const symbolRequest = {
    requestId: 'req-symbol',
    kind: 'hello',
  } as Request & {
    [key: symbol]: unknown;
  };
  symbolRequest[Symbol('hidden')] = true;
  assert.throws(() => encodeRequest(symbolRequest), invalidEnvelope);

  class RequestSubclass {
    requestId = 'req-class';
    kind = 'hello' as const;
  }
  assert.throws(() => encodeRequest(new RequestSubclass()), invalidEnvelope);

  const toJsonRequest = {
    requestId: 'req-to-json',
    kind: 'hello',
    toJSON: () => {
      toJsonCalls += 1;
      return { requestId: 'forged', kind: 'hello' };
    },
  } as unknown as Request;
  assert.throws(() => encodeRequest(toJsonRequest), invalidEnvelope);
  assert.equal(toJsonCalls, 0);

  const base = {
    version: { axis: 'accepted-operation' as const, version: 1 },
    requestId: 'req-error-source',
    kind: 'workflow.signal.submit',
  };
  const responseFor = (error: ProtocolError): Response => ({
    ...base,
    body: { type: 'error', error },
  });
  class ProtocolErrorSubclass extends ProtocolError {}
  const disguisedSubclass = new ProtocolErrorSubclass(codes.INTERNAL, 'x');
  Object.setPrototypeOf(disguisedSubclass, ProtocolError.prototype);
  assert.throws(() => encodeResponse(responseFor(disguisedSubclass)), invalidEnvelope);
  assert.throws(
    () =>
      encodeResponse(
        responseFor(
          Object.assign(Object.create(ProtocolError.prototype), {
            code: codes.INTERNAL,
            message: 'forged',
          }),
        ),
      ),
    invalidEnvelope,
  );

  const accessorError = new ProtocolError(codes.INTERNAL, 'x');
  Object.defineProperty(accessorError, 'code', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return codes.INTERNAL;
    },
  });
  assert.throws(() => encodeResponse(responseFor(accessorError)), invalidEnvelope);
  assert.equal(getterCalls, 0);

  const mutatedError = new ProtocolError(codes.INTERNAL, 'x');
  Object.defineProperty(mutatedError, 'code', {
    value: codes.HANDLER_TIMEOUT,
    enumerable: true,
  });
  assert.throws(() => encodeResponse(responseFor(mutatedError)), invalidEnvelope);

  const mutatedMessage = new ProtocolError(codes.INTERNAL, 'x');
  Object.defineProperty(mutatedMessage, 'message', { value: 'changed' });
  assert.throws(() => encodeResponse(responseFor(mutatedMessage)), invalidEnvelope);

  const authenticWithToJson = new ProtocolError(codes.INTERNAL, 'x') as ProtocolError & {
    toJSON?: () => unknown;
  };
  Object.defineProperty(authenticWithToJson, 'toJSON', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return () => {
        toJsonCalls += 1;
        return {};
      };
    },
  });
  const expected = encodeResponse(responseFor(new ProtocolError(codes.INTERNAL, 'x')));
  for (const key of ['name', 'stack', 'cause', 'custom'] as const) {
    Object.defineProperty(authenticWithToJson, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return `ignored-${key}`;
      },
    });
  }
  assert.equal(encodeResponse(responseFor(authenticWithToJson)), expected);
  assert.equal(getterCalls, 0);
  assert.equal(toJsonCalls, 0);
});

test('outbound validation rejects proxies before traps and ignores mutable array methods', () => {
  const invalidEnvelope = (error: unknown) =>
    error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE;
  const invalidPayload = (error: unknown) =>
    error instanceof ProtocolError && error.code === codes.INVALID_PAYLOAD;
  let objectProxyTraps = 0;
  let arrayProxyTraps = 0;
  let errorProxyTraps = 0;
  const trappingHandler = (increment: () => void): ProxyHandler<object> => ({
    getPrototypeOf() {
      increment();
      throw new Error('getPrototypeOf trap must not run');
    },
    ownKeys() {
      increment();
      throw new Error('ownKeys trap must not run');
    },
    getOwnPropertyDescriptor() {
      increment();
      throw new Error('getOwnPropertyDescriptor trap must not run');
    },
  });

  const requestProxy = new Proxy(
    { requestId: 'req-proxy', kind: 'hello' },
    trappingHandler(() => {
      objectProxyTraps += 1;
    }),
  ) as Request;
  assert.throws(() => encodeRequest(requestProxy), invalidEnvelope);
  assert.equal(objectProxyTraps, 0);

  const capabilitiesProxy = new Proxy(
    [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
    trappingHandler(() => {
      arrayProxyTraps += 1;
    }),
  ) as unknown as readonly string[];
  const proxyArrayResponse: Response = {
    version: { axis: 'bootstrap', version: 1 },
    requestId: 'req-array-proxy',
    kind: 'hello',
    body: {
      type: 'hello',
      info: {
        protocolVersion: 1,
        journalSchemaVersion: 1,
        capabilities: capabilitiesProxy,
        package: { name: 'aizign', version: '0.1.0' },
      },
    },
  };
  assert.throws(() => encodeResponse(proxyArrayResponse), invalidPayload);
  assert.equal(arrayProxyTraps, 0);

  const errorProxy = new Proxy(
    new ProtocolError(codes.INTERNAL, 'proxy'),
    trappingHandler(() => {
      errorProxyTraps += 1;
    }),
  ) as unknown as ProtocolError;
  assert.throws(
    () =>
      encodeResponse({
        version: { axis: 'accepted-operation', version: 1 },
        requestId: 'req-error-proxy',
        kind: 'workflow.signal.submit',
        body: { type: 'error', error: errorProxy },
      }),
    invalidEnvelope,
  );
  assert.equal(errorProxyTraps, 0);

  const everyDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'every');
  const includesDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'includes');
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  let everyCalls = 0;
  let includesCalls = 0;
  let iteratorCalls = 0;
  let capabilityFailure: unknown;
  let kindFailure: unknown;
  let roleFailure: unknown;
  let validFrame: string | undefined;
  const validResponse: Response = {
    version: { axis: 'bootstrap', version: 1 },
    requestId: 'req-poisoned-array-methods',
    kind: 'hello',
    body: {
      type: 'hello',
      info: {
        protocolVersion: 1,
        journalSchemaVersion: 1,
        capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
        package: { name: 'aizign', version: '0.1.0' },
      },
    },
  };
  const expectedFrame = encodeResponse(validResponse);
  try {
    Object.defineProperty(Array.prototype, 'every', {
      configurable: true,
      writable: true,
      value: () => {
        everyCalls += 1;
        return true;
      },
    });
    Object.defineProperty(Array.prototype, 'includes', {
      configurable: true,
      writable: true,
      value: () => {
        includesCalls += 1;
        return true;
      },
    });
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value: () => {
        iteratorCalls += 1;
        throw new Error('Array iterator must not run');
      },
    });
    try {
      encodeResponse({
        ...validResponse,
        body: {
          type: 'hello',
          info: {
            protocolVersion: 1,
            journalSchemaVersion: 1,
            capabilities: ['NOT_A_VALID_CAPABILITY'],
            package: { name: 'aizign', version: '0.1.0' },
          } as HelloInfo,
        },
      });
    } catch (error) {
      capabilityFailure = error;
    }
    try {
      const signal = { ...implementationReady('evt-poisoned-kind'), kind: 'future.kind' };
      encodeRequest(
        submitRequest(
          'req-poisoned-kind',
          expectedAssignment(),
          signal as unknown as WorkflowSignal,
        ),
      );
    } catch (error) {
      kindFailure = error;
    }
    try {
      const invalidExpected = { ...expectedAssignment(), role: 'operator' };
      encodeRequest(
        submitRequest(
          'req-poisoned-role',
          invalidExpected as unknown as ExpectedAssignment,
          implementationReady('evt-poisoned-role'),
        ),
      );
    } catch (error) {
      roleFailure = error;
    }
    validFrame = encodeResponse(validResponse);
  } finally {
    if (everyDescriptor !== undefined)
      Object.defineProperty(Array.prototype, 'every', everyDescriptor);
    if (includesDescriptor !== undefined)
      Object.defineProperty(Array.prototype, 'includes', includesDescriptor);
    if (iteratorDescriptor !== undefined)
      Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor);
  }
  assert.equal(everyCalls, 0);
  assert.equal(includesCalls, 0);
  assert.equal(iteratorCalls, 0);
  assert.ok(invalidPayload(capabilityFailure));
  assert.ok(invalidPayload(kindFailure));
  assert.ok(invalidPayload(roleFailure));
  assert.equal(validFrame, expectedFrame);
});

test('fresh wire graphs shadow inherited object and array toJSON hooks', () => {
  const request = { requestId: 'req-prototype-hook', kind: 'hello' } as const;
  const response: Response = {
    version: { axis: 'bootstrap', version: 1 },
    requestId: 'req-prototype-hook',
    kind: 'hello',
    body: {
      type: 'hello',
      info: {
        protocolVersion: 1,
        journalSchemaVersion: 1,
        capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
        package: { name: 'aizign', version: '0.1.0' },
      },
    },
  };
  const expectedRequest = encodeRequest(request);
  const expectedResponse = encodeResponse(response);
  const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let objectCalls = 0;
  let arrayCalls = 0;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get: () => {
        objectCalls += 1;
        return () => ({ forged: true });
      },
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: () => {
        arrayCalls += 1;
        return ['forged'];
      },
    });
    assert.equal(encodeRequest(request), expectedRequest);
    assert.equal(encodeResponse(response), expectedResponse);
    assert.equal(objectCalls, 0);
    assert.equal(arrayCalls, 0);
  } finally {
    if (objectToJson === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
    else Object.defineProperty(Object.prototype, 'toJSON', objectToJson);
    if (arrayToJson === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON;
    else Object.defineProperty(Array.prototype, 'toJSON', arrayToJson);
  }
});

test('fresh wire construction ignores inherited setters and getter-only properties', () => {
  const findingRequest = submitRequest(
    'req-inherited-setter',
    reviewExpectedAssignment(),
    reviewFindings('evt-inherited-setter'),
  );
  const blockedRequest = submitRequest(
    'req-inherited-code',
    expectedAssignment(),
    blocked('evt-inherited-code'),
  );
  const helloResponse: Response = {
    version: { axis: 'bootstrap', version: 1 },
    requestId: 'req-inherited-array',
    kind: 'hello',
    body: {
      type: 'hello',
      info: {
        protocolVersion: 1,
        journalSchemaVersion: 1,
        capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
        package: { name: 'aizign', version: '0.1.0' },
      },
    },
  };
  const expectedFinding = encodeRequest(findingRequest);
  const expectedBlocked = encodeRequest(blockedRequest);
  const expectedHello = encodeResponse(helloResponse);
  const keys = ['findingCount', 'artifactRef', 'shortErrorCode'] as const;
  const originals = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const),
  );
  const arrayZero = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let calls = 0;
  let actualFinding = '';
  let actualBlocked = '';
  let actualHello = '';
  try {
    Object.defineProperty(Object.prototype, 'findingCount', {
      configurable: true,
      set: () => {
        calls += 1;
      },
    });
    Object.defineProperty(Object.prototype, 'artifactRef', {
      configurable: true,
      get: () => {
        calls += 1;
        return 'forged';
      },
    });
    Object.defineProperty(Object.prototype, 'shortErrorCode', {
      configurable: true,
      set: () => {
        calls += 1;
      },
    });
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      set: () => {
        calls += 1;
      },
    });
    actualFinding = encodeRequest(findingRequest);
    actualBlocked = encodeRequest(blockedRequest);
    actualHello = encodeResponse(helloResponse);
  } finally {
    for (const key of keys) {
      const descriptor = originals.get(key);
      if (descriptor === undefined) delete (Object.prototype as Record<string, unknown>)[key];
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
    if (arrayZero === undefined)
      delete (Array.prototype as unknown as Record<string, unknown>)['0'];
    else Object.defineProperty(Array.prototype, '0', arrayZero);
  }
  assert.equal(calls, 0);
  assert.equal(actualFinding, expectedFinding);
  assert.equal(actualBlocked, expectedBlocked);
  assert.equal(actualHello, expectedHello);
});
