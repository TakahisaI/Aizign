import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProcessProfileRegistry } from '../../../spec/process/v1/fixtures/registry.mjs';
import {
  BOOTSTRAP_ENVELOPE_VERSION,
  DecodeFailure,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BYTES,
  OneShotFrameCollector,
  type Request,
} from './envelope.ts';
import { codes, ProtocolError } from './error.ts';

test('protocol executes every assigned process-profile version case', async () => {
  const registry = createProcessProfileRegistry('protocol');
  const failure = (kind: unknown, version: number) => {
    try {
      decodeRequest(
        JSON.stringify({
          protocol: 'aizign',
          version,
          requestId: 'req-version-axis',
          kind,
          payload: {},
        }),
      );
      assert.fail('request unexpectedly decoded');
    } catch (error) {
      assert.ok(error instanceof DecodeFailure);
      return error;
    }
  };

  await registry.run('hello-future-operation', () => {
    const response = decodeResponse(
      encodeResponse({
        version: { axis: 'bootstrap', version: 1 },
        requestId: 'req-future-operation',
        kind: 'hello',
        body: {
          type: 'hello',
          info: {
            protocolVersion: 2,
            journalSchemaVersion: 1,
            capabilities: [],
            package: { name: 'future-core', version: '2.0.0' },
          },
        },
      }),
    );
    assert.deepEqual(response.version, { axis: 'bootstrap', version: 1 });
    assert.equal(response.body.type === 'hello' && response.body.info.protocolVersion, 2);
  });
  await registry.run('version-bootstrap-unsupported', () => {
    const error = failure('hello', 2);
    assert.equal(error.error.code, codes.PROTOCOL_VERSION_UNSUPPORTED);
    assert.deepEqual(error.responseVersion, { axis: 'bootstrap', version: 1 });
  });
  await registry.run('version-submit-unsupported', () => {
    const error = failure('workflow.signal.submit', 2);
    assert.equal(error.error.code, codes.PROTOCOL_VERSION_UNSUPPORTED);
    assert.deepEqual(error.responseVersion, { axis: 'bootstrap', version: 1 });
  });
  await registry.run('version-reconcile-unsupported', () => {
    const error = failure('workflow.signal.reconcile', 2);
    assert.equal(error.error.code, codes.PROTOCOL_VERSION_UNSUPPORTED);
    assert.deepEqual(error.responseVersion, { axis: 'bootstrap', version: 1 });
  });
  await registry.run('version-future-kind-unsupported', () => {
    const error = failure('future.operation', 2);
    assert.equal(error.error.code, codes.PROTOCOL_VERSION_UNSUPPORTED);
    assert.deepEqual(error.responseVersion, { axis: 'bootstrap', version: 1 });
  });
  await registry.run('kind-future-accepted-version', () => {
    const error = failure('future.operation', 1);
    assert.equal(error.error.code, codes.UNKNOWN_KIND);
    assert.deepEqual(error.responseVersion, {
      axis: 'accepted-operation',
      version: 1,
    });
  });
  registry.complete();
});

test('response encoding keeps the explicit axis when operation and bootstrap versions diverge', () => {
  const body = {
    type: 'error' as const,
    error: new ProtocolError(codes.INTERNAL, 'failed'),
  };
  assert.match(
    encodeResponse({
      version: { axis: 'accepted-operation', version: 2 },
      requestId: 'req-operation-v2',
      kind: 'workflow.signal.submit',
      body,
    }),
    /"version":2/,
  );
  assert.match(
    encodeResponse({
      version: { axis: 'bootstrap', version: 1 },
      requestId: 'req-bootstrap-v7',
      kind: 'workflow.signal.submit',
      body,
    }),
    /"version":1/,
  );

  const nullKindError = encodeResponse({
    version: { axis: 'accepted-operation', version: 1 },
    requestId: 'req-unsafe-kind',
    kind: null,
    body,
  });
  assert.deepEqual(
    decodeResponse(nullKindError, {
      requestAxis: 'accepted-operation',
      bootstrapVersion: 1,
      operationVersion: 1,
    }).version,
    {
      axis: 'accepted-operation',
      version: 1,
    },
  );
  assert.deepEqual(
    decodeResponse(
      encodeResponse({
        version: { axis: 'bootstrap', version: 1 },
        requestId: null,
        kind: null,
        body: {
          type: 'error',
          error: new ProtocolError(codes.PROTOCOL_VERSION_UNSUPPORTED, 'unsupported'),
        },
      }),
      {
        requestAxis: 'accepted-operation',
        bootstrapVersion: 1,
        operationVersion: 2,
      },
    ).version,
    { axis: 'bootstrap', version: 1 },
  );

  const operationV2 = encodeResponse({
    version: { axis: 'accepted-operation', version: 2 },
    requestId: 'req-operation-v2',
    kind: 'workflow.signal.submit',
    body,
  });
  assert.deepEqual(
    decodeResponse(operationV2, {
      requestAxis: 'accepted-operation',
      bootstrapVersion: 1,
      operationVersion: 2,
    }).version,
    { axis: 'accepted-operation', version: 2 },
  );
  assert.throws(
    () =>
      decodeResponse(operationV2, {
        requestAxis: 'accepted-operation',
        bootstrapVersion: 1,
        operationVersion: 3,
      }),
    (error: unknown) =>
      error instanceof DecodeFailure && error.error.code === codes.PROTOCOL_VERSION_UNSUPPORTED,
  );
});

test('encoded frames are single lines with escaped newlines', () => {
  assert.equal(BOOTSTRAP_ENVELOPE_VERSION, 1);
  const frame = encodeResponse({
    version: { axis: 'bootstrap', version: 1 },
    requestId: null,
    kind: null,
    body: {
      type: 'error',
      error: new ProtocolError(codes.INTERNAL, 'line one\nline two'),
    },
  });
  assert.ok(!frame.includes('\n'));
  const decoded = decodeResponse(frame);
  assert.equal(decoded.body.type, 'error');
  assert.equal(decoded.requestId, null);

  const request: Request = { requestId: 'req-1', kind: 'hello' };
  assert.equal(
    encodeRequest(request),
    '{"protocol":"aizign","version":1,"requestId":"req-1","kind":"hello","payload":{}}',
  );
});

test('malformed codes are rejected rather than normalized', () => {
  assert.throws(() => new ProtocolError('not a code', 'm'), TypeError);
  assert.equal(new ProtocolError('FUTURE_OUTCOME_UNKNOWN', 'm').code, 'FUTURE_OUTCOME_UNKNOWN');
});

test('malformed JSON grammar is rejected before correlation recovery', () => {
  const prefix =
    '{"protocol":"aizign","version":1,"requestId":"req-syntax","kind":"hello","payload":{"value":';
  for (const value of ['1e', '1.', '01', '-', String.raw`"\q"`, String.raw`"\u12"`]) {
    assert.throws(
      () => decodeRequest(`${prefix}${value}}}`),
      (error: unknown) =>
        error instanceof DecodeFailure &&
        error.error.code === codes.INVALID_ENVELOPE &&
        error.requestId === null &&
        error.kind === null &&
        error.responseVersion.axis === 'bootstrap',
      value,
    );
  }
});

test('an ill-formed top-level kind is not retained as correlation metadata', () => {
  assert.throws(
    () =>
      decodeRequest(
        String.raw`{"protocol":"aizign","version":1,"requestId":"req-unicode","kind":"\uD800","payload":{}}`,
      ),
    (error: unknown) =>
      error instanceof DecodeFailure &&
      error.error.code === codes.INVALID_ENVELOPE &&
      error.requestId === 'req-unicode' &&
      error.kind === null,
  );
});

test('an ill-formed top-level member name suppresses all correlation', () => {
  const requestFrames = [
    String.raw`{"\uD800":0,"protocol":"aizign","version":1,"requestId":"req-before","kind":"hello","payload":{}}`,
    String.raw`{"protocol":"aizign","version":1,"requestId":"req-between","\uD800":0,"kind":"hello","payload":{}}`,
    String.raw`{"protocol":"aizign","version":1,"requestId":"req-after","kind":"hello","\uD800":0,"payload":{}}`,
    String.raw`{"protocol":"aizign","version":1,"requestId":"req-old","requestId":"req-final","kind":"hello","\uD800":0,"payload":{}}`,
    String.raw`{"protocol":"aizign","version":2,"requestId":"req-version","kind":"hello","\uD800":0,"payload":{}}`,
  ];
  for (const frame of requestFrames) {
    assert.throws(
      () => decodeRequest(frame),
      (error: unknown) =>
        error instanceof DecodeFailure &&
        error.error.code === codes.INVALID_ENVELOPE &&
        error.requestId === null &&
        error.kind === null &&
        error.responseVersion.axis === 'bootstrap' &&
        error.responseVersion.version === 1,
      frame,
    );
  }

  const responseFrames = [
    String.raw`{"\uD800":0,"protocol":"aizign","version":2,"requestId":"req-before","kind":"workflow.signal.submit","ok":false,"error":{"code":"INTERNAL","message":"x"}}`,
    String.raw`{"protocol":"aizign","version":2,"requestId":"req-between","\uD800":0,"kind":"workflow.signal.submit","ok":false,"error":{"code":"INTERNAL","message":"x"}}`,
    String.raw`{"protocol":"aizign","version":2,"requestId":"req-after","kind":"workflow.signal.submit","\uD800":0,"ok":false,"error":{"code":"INTERNAL","message":"x"}}`,
    String.raw`{"protocol":"aizign","version":2,"requestId":"req-old","requestId":"req-final","kind":"workflow.signal.submit","\uD800":0,"ok":false,"error":{"code":"INTERNAL","message":"x"}}`,
    String.raw`{"protocol":"aizign","version":3,"requestId":"req-version","kind":"workflow.signal.submit","\uD800":0,"ok":false,"error":{"code":"INTERNAL","message":"x"}}`,
  ];
  for (const frame of responseFrames) {
    assert.throws(
      () =>
        decodeResponse(frame, {
          requestAxis: 'accepted-operation',
          bootstrapVersion: 1,
          operationVersion: 2,
        }),
      (error: unknown) =>
        error instanceof DecodeFailure &&
        error.error.code === codes.INVALID_ENVELOPE &&
        error.requestId === null &&
        error.kind === null &&
        error.responseVersion.axis === 'accepted-operation' &&
        error.responseVersion.version === 2,
      frame,
    );
  }

  const nested = String.raw`{"protocol":"aizign","version":1,"requestId":"req-nested-key","kind":"hello","payload":{"\uD800":0}}`;
  assert.throws(
    () => decodeRequest(nested),
    (error: unknown) =>
      error instanceof DecodeFailure &&
      error.error.code === codes.INVALID_ENVELOPE &&
      error.requestId === 'req-nested-key' &&
      error.kind === 'hello',
  );
});

test('canonical integers beyond the host numeric range remain payload failures', () => {
  const huge = `1${'0'.repeat(400)}`;
  const digest = 'a'.repeat(64);
  const request = `{"protocol":"aizign","version":1,"requestId":"req-huge","kind":"workflow.signal.submit","payload":{"expected":{"workflowId":"wf-1","assignmentId":"as-1","attemptId":"attempt-1","role":"review","artifactRevision":"rev-1","candidateDigest":{"algorithm":"sha256","hex":"${digest}"}},"signal":{"eventId":"evt-1","workflowId":"wf-1","assignmentId":"as-1","attemptId":"attempt-1","role":"review","artifactRevision":"rev-1","candidateDigest":{"algorithm":"sha256","hex":"${digest}"},"kind":"review_findings","findingCount":${huge}}}}`;
  assert.throws(
    () => decodeRequest(request),
    (error: unknown) =>
      error instanceof DecodeFailure && error.error.code === codes.INVALID_PAYLOAD,
  );

  const response = `{"protocol":"aizign","version":1,"requestId":"req-huge","kind":"hello","ok":true,"payload":{"protocolVersion":${huge},"journalSchemaVersion":1,"capabilities":[],"package":{"name":"aizign","version":"0.1.0"}}}`;
  assert.throws(
    () => decodeResponse(response),
    (error: unknown) =>
      error instanceof DecodeFailure && error.error.code === codes.INVALID_PAYLOAD,
  );
});

test('a successful operation-shaped response cannot select bootstrap from an error code', () => {
  const frame = JSON.stringify({
    protocol: 'aizign',
    version: 2,
    requestId: 'req-axis-cross-product',
    kind: 'workflow.signal.submit',
    ok: true,
    error: {
      code: codes.PROTOCOL_VERSION_UNSUPPORTED,
      message: 'not an error response',
    },
  });
  assert.throws(
    () =>
      decodeResponse(frame, {
        requestAxis: 'accepted-operation',
        bootstrapVersion: 1,
        operationVersion: 2,
      }),
    (error: unknown) =>
      error instanceof DecodeFailure &&
      error.error.code === codes.INVALID_ENVELOPE &&
      error.responseVersion.axis === 'accepted-operation' &&
      error.responseVersion.version === 2,
  );
});

test('response version selection uses only boolean ok=false for bootstrap errors', () => {
  const cases: ReadonlyArray<readonly [string, string, 'bootstrap' | 'accepted-operation']> = [
    ['true', 'true', 'accepted-operation'],
    ['false', 'false', 'bootstrap'],
    ['missing', '', 'accepted-operation'],
    ['null', 'null', 'accepted-operation'],
    ['string', '"false"', 'accepted-operation'],
  ];
  for (const [name, token, axis] of cases) {
    const okMember = name === 'missing' ? '' : `,"ok":${token}`;
    const frame = `{"protocol":"aizign","version":${axis === 'bootstrap' ? 1 : 2},"requestId":"req-ok-${name}","kind":"workflow.signal.submit"${okMember},"error":{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"unsupported"}}`;
    try {
      const response = decodeResponse(frame, {
        requestAxis: 'accepted-operation',
        bootstrapVersion: 1,
        operationVersion: 2,
      });
      assert.equal(name, 'false', `${name}: malformed response unexpectedly decoded`);
      assert.deepEqual(response.version, { axis: 'bootstrap', version: 1 }, name);
      assert.equal(response.requestId, 'req-ok-false', name);
      assert.equal(response.kind, 'workflow.signal.submit', name);
      assert.equal(
        response.body.type === 'error' && response.body.error.code,
        codes.PROTOCOL_VERSION_UNSUPPORTED,
        name,
      );
    } catch (error) {
      assert.ok(error instanceof DecodeFailure, name);
      assert.equal(error.responseVersion.axis, axis, name);
      assert.equal(error.responseVersion.version, 2, name);
      assert.equal(error.error.code, codes.INVALID_ENVELOPE, name);
      assert.equal(error.requestId, `req-ok-${name}`, name);
      assert.equal(error.kind, 'workflow.signal.submit', name);
      assert.notEqual(name, 'false', `${name}: valid bootstrap error was rejected`);
    }
  }
});

test('duplicate members recover only the final typed spelling', () => {
  const requestCases: ReadonlyArray<readonly [string, string, string | null]> = [
    ['string-to-number', '"old","requestId":17', null],
    ['string-to-null', '"old","requestId":null', null],
    ['string-to-object', '"old","requestId":{}', null],
    ['number-to-string', '17,"requestId":"req-final"', 'req-final'],
  ];
  for (const [name, duplicate, expectedRequestId] of requestCases) {
    const frame = `{"protocol":"aizign","version":1,"requestId":${duplicate},"kind":"hello","payload":{}}`;
    assert.throws(
      () => decodeRequest(frame),
      (error: unknown) =>
        error instanceof DecodeFailure &&
        error.error.code === codes.INVALID_ENVELOPE &&
        error.requestId === expectedRequestId,
      name,
    );
  }

  for (const [name, finalOk] of [
    ['false-to-null', 'null'],
    ['false-to-string', '"false"'],
  ] as const) {
    const frame = `{"protocol":"aizign","version":2,"requestId":"req-${name}","kind":"workflow.signal.submit","ok":false,"ok":${finalOk},"error":{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"unsupported"}}`;
    assert.throws(
      () =>
        decodeResponse(frame, {
          requestAxis: 'accepted-operation',
          bootstrapVersion: 1,
          operationVersion: 2,
        }),
      (error: unknown) =>
        error instanceof DecodeFailure &&
        error.error.code === codes.INVALID_ENVELOPE &&
        error.responseVersion.axis === 'accepted-operation' &&
        error.responseVersion.version === 2,
      name,
    );
  }

  const replacedError =
    '{"protocol":"aizign","version":2,"requestId":"req-error-null","kind":"workflow.signal.submit","ok":false,"error":{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"unsupported"},"error":null}';
  assert.throws(
    () =>
      decodeResponse(replacedError, {
        requestAxis: 'accepted-operation',
        bootstrapVersion: 1,
        operationVersion: 2,
      }),
    (error: unknown) =>
      error instanceof DecodeFailure &&
      error.error.code === codes.INVALID_ENVELOPE &&
      error.responseVersion.axis === 'accepted-operation' &&
      error.responseVersion.version === 2,
  );
});

test('only a direct error code can select the bootstrap response axis', () => {
  const nested =
    '{"protocol":"aizign","version":2,"requestId":"req-nested-code","kind":"workflow.signal.submit","ok":false,"error":{"meta":{"code":"PROTOCOL_VERSION_UNSUPPORTED"},"message":"unsupported"}}';
  assert.throws(
    () =>
      decodeResponse(nested, {
        requestAxis: 'accepted-operation',
        bootstrapVersion: 1,
        operationVersion: 2,
      }),
    (error: unknown) =>
      error instanceof DecodeFailure &&
      error.error.code === codes.INVALID_ENVELOPE &&
      error.requestId === 'req-nested-code' &&
      error.responseVersion.axis === 'accepted-operation' &&
      error.responseVersion.version === 2,
  );

  const direct =
    '{"protocol":"aizign","version":1,"requestId":"req-direct-code","kind":"workflow.signal.submit","ok":false,"error":{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"unsupported"}}';
  assert.deepEqual(
    decodeResponse(direct, {
      requestAxis: 'accepted-operation',
      bootstrapVersion: 1,
      operationVersion: 2,
    }).version,
    { axis: 'bootstrap', version: 1 },
  );
});

test('deep future payloads are scanned at every depth before version routing', () => {
  const wrap = (leaf: string) => `${'{"next":'.repeat(180)}${leaf}${'}'.repeat(180)}`;
  const valid = `{"protocol":"aizign","version":2,"requestId":"req-deep","kind":"future.operation","payload":${wrap('{}')}}`;
  assert.throws(
    () => decodeRequest(valid),
    (error: unknown) =>
      error instanceof DecodeFailure &&
      error.error.code === codes.PROTOCOL_VERSION_UNSUPPORTED &&
      error.requestId === 'req-deep' &&
      error.kind === 'future.operation',
  );
  const duplicate = `{"protocol":"aizign","version":2,"requestId":"req-deep","kind":"future.operation","payload":${wrap('{"same":1,"same":2}')}}`;
  assert.throws(
    () => decodeRequest(duplicate),
    (error: unknown) =>
      error instanceof DecodeFailure && error.error.code === codes.INVALID_ENVELOPE,
  );
});

test('deep payload detection preserves envelope and routing precedence', () => {
  const wrap = (leaf: string) => `${'{"next":'.repeat(180)}${leaf}${'}'.repeat(180)}`;
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [
      'known-kind',
      `{"protocol":"aizign","version":1,"requestId":"req-known","kind":"hello","payload":${wrap('{}')}}`,
      codes.INVALID_PAYLOAD,
    ],
    [
      'unknown-kind',
      `{"protocol":"aizign","version":1,"requestId":"req-unknown","kind":"future.operation","payload":${wrap('{}')}}`,
      codes.UNKNOWN_KIND,
    ],
    [
      'missing-kind',
      `{"protocol":"aizign","version":1,"requestId":"req-missing","payload":${wrap('{}')}}`,
      codes.INVALID_ENVELOPE,
    ],
    [
      'non-string-kind',
      `{"protocol":"aizign","version":1,"requestId":"req-non-string","kind":17,"payload":${wrap('{}')}}`,
      codes.INVALID_ENVELOPE,
    ],
    [
      'unknown-envelope-member',
      `{"protocol":"aizign","version":1,"requestId":"req-extra","kind":"hello","payload":${wrap('{}')},"extra":true}`,
      codes.INVALID_ENVELOPE,
    ],
    [
      'unsupported-version',
      `{"protocol":"aizign","version":2,"requestId":"req-version","kind":"hello","payload":${wrap('{}')}}`,
      codes.PROTOCOL_VERSION_UNSUPPORTED,
    ],
  ];
  for (const [name, frame, expected] of cases) {
    assert.throws(
      () => decodeRequest(frame),
      (error: unknown) => error instanceof DecodeFailure && error.error.code === expected,
      name,
    );
  }
});

test('request validation precedes the package-internal final bound guard', async () => {
  assert.throws(
    () =>
      encodeRequest({
        requestId: `r${'x'.repeat(MAX_REQUEST_BYTES)}`,
        kind: 'hello',
      }),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
  );
  const { finishRequestFrame } = await import('./envelope.ts');
  assert.equal(finishRequestFrame('x'.repeat(MAX_REQUEST_BYTES)).length, MAX_REQUEST_BYTES);
  assert.throws(
    () => finishRequestFrame('x'.repeat(MAX_REQUEST_BYTES + 1)),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.REQUEST_TOO_LARGE,
  );
});

test('the response encoder accepts exactly the bound and rejects the next byte', () => {
  const make = (message: string) =>
    encodeResponse({
      version: { axis: 'accepted-operation', version: 1 },
      requestId: 'req-1',
      kind: 'workflow.signal.submit',
      body: {
        type: 'error',
        error: new ProtocolError(codes.INTERNAL, message),
      },
    });
  const overhead = new TextEncoder().encode(make('')).byteLength;
  const exact = make('x'.repeat(MAX_FRAME_BYTES - overhead));
  assert.equal(new TextEncoder().encode(exact).byteLength, MAX_FRAME_BYTES);
  assert.throws(
    () => make('x'.repeat(MAX_FRAME_BYTES - overhead + 1)),
    (error: unknown) => error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE,
  );
});

test('encoders reject ill-formed Unicode before returning a frame', () => {
  const isInvalidEnvelope = (error: unknown) =>
    error instanceof ProtocolError && error.code === codes.INVALID_ENVELOPE;

  assert.throws(
    () => encodeRequest({ requestId: '\ud800', kind: 'hello' }),
    isInvalidEnvelope,
    'request encoder returned a frame containing a lone surrogate',
  );
  assert.throws(
    () =>
      encodeResponse({
        version: { axis: 'bootstrap', version: 1 },
        requestId: null,
        kind: null,
        body: {
          type: 'error',
          error: new ProtocolError(codes.INTERNAL, '\ud800'),
        },
      }),
    isInvalidEnvelope,
    'response encoder returned a frame containing a lone surrogate',
  );
});

test('extractFrame accepts exactly one LF-terminated frame and immediate close', async () => {
  const { extractFrame } = await import('./envelope.ts');
  const text = new TextDecoder('utf-8', { fatal: true });
  const first = extractFrame('{"a":1}\n');
  assert.equal(first.kind, 'frame');
  if (first.kind === 'frame') assert.equal(text.decode(first.frame), '{"a":1}');
  assert.equal(extractFrame('{"a":1}\n ').kind, 'extra');
  assert.equal(extractFrame('{"a":1}\n\t').kind, 'extra');
  assert.equal(extractFrame('{"a":1}\n\n').kind, 'extra');
  assert.equal(extractFrame('{"a":1}\r\n').kind, 'extra');
  assert.deepEqual(extractFrame(''), { kind: 'empty' });
  assert.deepEqual(extractFrame('\n'), { kind: 'empty' });
  assert.equal(extractFrame('{"a":1}').kind, 'extra', 'a frame that never ended');
  assert.equal(extractFrame('{"a":1}\n{"b":2}\n').kind, 'extra', 'two frames');
  assert.equal(extractFrame('{"a":1}\nprose').kind, 'extra', 'trailing content');
  assert.equal(extractFrame('{"a":1}\n\u00a0').kind, 'extra', 'Unicode whitespace is content');

  const invalidUtf8 = Uint8Array.from([0x7b, 0xff, 0x7d, 0x0a]);
  const invalidFrame = extractFrame(invalidUtf8);
  assert.equal(invalidFrame.kind, 'frame');
  if (invalidFrame.kind === 'frame') {
    assert.deepEqual([...invalidFrame.frame], [0x7b, 0xff, 0x7d]);
    assert.throws(
      () => decodeResponse(invalidFrame.frame),
      (error: unknown) =>
        error instanceof DecodeFailure && error.error.code === codes.INVALID_ENVELOPE,
    );
  }
});

test('the process collector bounds the body and rejects every byte after LF', () => {
  const exact = new OneShotFrameCollector(4);
  assert.equal(exact.append(Uint8Array.from([0x31, 0x32])), true);
  assert.equal(exact.append(Uint8Array.from([0x33, 0x34, 0x0a])), true);
  const extraction = exact.extract();
  assert.equal(extraction.kind, 'frame');
  if (extraction.kind === 'frame')
    assert.deepEqual([...extraction.frame], [0x31, 0x32, 0x33, 0x34]);

  const oversized = new OneShotFrameCollector(4);
  assert.equal(oversized.append(Uint8Array.from([0x31, 0x32, 0x33, 0x34])), true);
  assert.equal(oversized.append(Uint8Array.from([0x35, 0x0a])), false);
  assert.equal(oversized.extract().kind, 'oversized');

  const trailingContent = new OneShotFrameCollector(4);
  assert.equal(trailingContent.append(Uint8Array.from([0x31, 0x0a, 0x20])), true);
  assert.equal(trailingContent.extract().kind, 'extra');

  const crlf = new OneShotFrameCollector(4);
  assert.equal(crlf.append(Uint8Array.from([0x31, 0x0d, 0x0a])), true);
  assert.equal(crlf.extract().kind, 'extra');
});

test('oversized or badly addressed responses are invalid envelopes', async () => {
  const { MAX_FRAME_BYTES } = await import('./envelope.ts');
  const big = `{"protocol":"aizign","version":1,"requestId":"r","kind":"hello","ok":false,"error":{"code":"INTERNAL","message":"${'x'.repeat(MAX_FRAME_BYTES)}"}}`;
  assert.throws(
    () => decodeResponse(big),
    (error: unknown) =>
      error instanceof DecodeFailure && error.error.code === codes.INVALID_ENVELOPE,
  );
  const bad =
    '{"protocol":"aizign","version":1,"requestId":"bad id","kind":"hello","ok":false,"error":{"code":"INTERNAL","message":"m"}}';
  assert.throws(
    () => decodeResponse(bad),
    (error: unknown) =>
      error instanceof DecodeFailure && error.error.code === codes.INVALID_ENVELOPE,
  );
});
