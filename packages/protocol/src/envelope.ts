/**
 * Request and response envelopes: the one-line NDJSON frames that cross the
 * process boundary. Decoding follows the same stages as the Rust
 * implementation so both reject the same frames with the same codes.
 */

import { codes, isAuthenticProtocolError, isShortErrorCode, ProtocolError } from './error.ts';
import { decodeHelloInfo, type HelloInfo } from './hello.ts';
import { isWellFormedUnicode, scanJsonTokens } from './json-token.ts';
import {
  assertClosedObject,
  assertOnlyKeys,
  IDENTIFIER_PATTERN,
  isPlainObject,
  ownDataValue,
} from './shape.ts';
import {
  decodeReconciliationResult,
  decodeSignalResult,
  decodeWorkflowSignalReconcile,
  decodeWorkflowSignalSubmit,
  encodeWorkflowSignalReconcile,
  encodeWorkflowSignalSubmit,
  type ReconciliationResult,
  type SignalResult,
  type WorkflowSignalReconcilePayload,
  type WorkflowSignalSubmitPayload,
} from './workflow-signal.ts';

export const PROTOCOL_NAME = 'aizign';
export const PROTOCOL_VERSION = 1;
/** Stable envelope version used before an operation version is accepted. */
export const BOOTSTRAP_ENVELOPE_VERSION = 1;
/** Upper bound on any frame, request or response, in bytes. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Alias kept for callers that only deal with requests. */
export const MAX_REQUEST_BYTES = MAX_FRAME_BYTES;
export const KIND_HELLO = 'hello';
export const KIND_WORKFLOW_SIGNAL_SUBMIT = 'workflow.signal.submit';
export const KIND_WORKFLOW_SIGNAL_RECONCILE = 'workflow.signal.reconcile';

export type Request =
  | { readonly requestId: string; readonly kind: 'hello' }
  | {
      readonly requestId: string;
      readonly kind: 'workflow.signal.submit';
      readonly payload: WorkflowSignalSubmitPayload;
    }
  | {
      readonly requestId: string;
      readonly kind: 'workflow.signal.reconcile';
      readonly payload: WorkflowSignalReconcilePayload;
    };

export type ResponseBody =
  | { readonly type: 'hello'; readonly info: HelloInfo }
  | { readonly type: 'workflow.signal'; readonly result: SignalResult }
  | { readonly type: 'workflow.signal.reconciliation'; readonly result: ReconciliationResult }
  | { readonly type: 'error'; readonly error: ProtocolError };

/** Source-qualified version axis retained even while both wire values are 1. */
export type ResponseVersion =
  | { readonly axis: 'bootstrap'; readonly version: number }
  | { readonly axis: 'accepted-operation'; readonly version: number };

export interface Response {
  /** The stage that owns the numeric envelope version. */
  readonly version: ResponseVersion;
  /** Echoed request id; `null` only when the request was unrecoverable. */
  readonly requestId: string | null;
  /** Echoed kind; `null` only when the request was unrecoverable. */
  readonly kind: string | null;
  readonly body: ResponseBody;
}

interface ResponseDecodeContext {
  readonly requestAxis?: ResponseVersion['axis'];
  readonly bootstrapVersion?: number;
  readonly operationVersion?: number;
}

/** A request that could not be decoded, with recovered correlation data. */
export class DecodeFailure extends Error {
  readonly requestId: string | null;
  readonly kind: string | null;
  readonly responseVersion: ResponseVersion;
  readonly error: ProtocolError;

  constructor(
    requestId: string | null,
    kind: string | null,
    responseVersion: ResponseVersion,
    error: ProtocolError,
  ) {
    super(error.message);
    this.name = 'DecodeFailure';
    this.requestId = requestId;
    this.kind = kind;
    this.responseVersion = responseVersion;
    this.error = error;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function byteLength(frame: Uint8Array | string): number {
  return typeof frame === 'string' ? encoder.encode(frame).byteLength : frame.byteLength;
}

function decodeFrame(frame: Uint8Array | string): string {
  if (typeof frame === 'string') return frame;
  if (frame[0] === 0xef && frame[1] === 0xbb && frame[2] === 0xbf) {
    throw new SyntaxError('UTF-8 BOM is not allowed before a JSON frame');
  }
  return decoder.decode(frame);
}

/**
 * Recovers correlation data the way the lenient request probe would see it
 * after folding: each field keeps its last spelling, and only a value that
 * passes its usual check is recovered.
 */
type Recovered = { requestId: string | null; kind: string | null };

function correlationFromFolded(folded: Record<string, unknown>): Recovered {
  const requestId =
    typeof folded.requestId === 'string' &&
    isWellFormedUnicode(folded.requestId) &&
    IDENTIFIER_PATTERN.test(folded.requestId)
      ? folded.requestId
      : null;
  const kind =
    typeof folded.kind === 'string' && isWellFormedUnicode(folded.kind) ? folded.kind : null;
  return { requestId, kind };
}

function foldedProbe(probeText: string): Record<string, unknown> | null {
  try {
    const folded: unknown = JSON.parse(probeText);
    return isPlainObject(folded) ? folded : null;
  } catch {
    return null;
  }
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

const MAX_VERSION = 4_294_967_295;
const MAX_VERSION_TEXT = String(MAX_VERSION);

function parseVersionToken(token: string | undefined): number | null {
  if (token === undefined || token.startsWith('-')) return null;
  if (token.length > MAX_VERSION_TEXT.length) return null;
  if (token.length === MAX_VERSION_TEXT.length && token > MAX_VERSION_TEXT) return null;
  return Number(token);
}

/**
 * Decodes one request frame. Throws {@link DecodeFailure} carrying the
 * stable code and whatever `requestId` / `kind` could be recovered.
 */
export function decodeRequest(frame: Uint8Array | string): Request {
  const bootstrapVersion = {
    axis: 'bootstrap',
    version: BOOTSTRAP_ENVELOPE_VERSION,
  } as const;
  const unaddressed = (code: string, message: string) =>
    new DecodeFailure(null, null, bootstrapVersion, new ProtocolError(code, message));

  const size = byteLength(frame);
  if (size > MAX_FRAME_BYTES) {
    throw unaddressed(
      codes.REQUEST_TOO_LARGE,
      `request is ${size} bytes; at most ${MAX_FRAME_BYTES} allowed`,
    );
  }

  let text: string;
  try {
    text = decodeFrame(frame);
  } catch (error) {
    throw unaddressed(codes.INVALID_ENVELOPE, `frame is not JSON: ${(error as Error).message}`);
  }
  const scan = scanJsonTokens(text);
  const probe = foldedProbe(scan.probeText);
  if (probe === null) {
    throw unaddressed(codes.INVALID_ENVELOPE, 'frame must be a JSON object');
  }
  const requestId = isRequestId(probe.requestId) ? probe.requestId : null;
  const kind = typeof probe.kind === 'string' ? probe.kind : null;
  const bootstrapFail = (code: string, message: string) =>
    new DecodeFailure(requestId, kind, bootstrapVersion, new ProtocolError(code, message));

  if (scan.failure !== null) {
    throw bootstrapFail(
      scan.failure.kind === 'noncanonical-number' && scan.failure.inPayload
        ? codes.INVALID_PAYLOAD
        : codes.INVALID_ENVELOPE,
      scan.failure.message,
    );
  }

  if (probe.protocol !== PROTOCOL_NAME) {
    throw bootstrapFail(codes.INVALID_ENVELOPE, `protocol must be "${PROTOCOL_NAME}"`);
  }
  const version = parseVersionToken(scan.topLevelNumbers.get('version'));
  if (version === null) {
    throw bootstrapFail(
      codes.INVALID_ENVELOPE,
      `version must be an integer between 0 and ${MAX_VERSION}`,
    );
  }
  const recoveredKind = typeof probe.kind === 'string' ? probe.kind : undefined;
  const acceptedVersion =
    recoveredKind === undefined
      ? undefined
      : recoveredKind === KIND_HELLO
        ? BOOTSTRAP_ENVELOPE_VERSION
        : PROTOCOL_VERSION;
  if (acceptedVersion !== undefined && version !== acceptedVersion) {
    throw bootstrapFail(
      codes.PROTOCOL_VERSION_UNSUPPORTED,
      `protocol version ${version} is not supported; this axis speaks ${acceptedVersion}`,
    );
  }
  const responseVersion: ResponseVersion =
    recoveredKind !== undefined && recoveredKind !== KIND_HELLO
      ? { axis: 'accepted-operation', version: PROTOCOL_VERSION }
      : bootstrapVersion;
  const fail = (code: string, message: string) =>
    new DecodeFailure(requestId, kind, responseVersion, new ProtocolError(code, message));

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw fail(codes.INVALID_ENVELOPE, `frame is not JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(value)) throw fail(codes.INVALID_ENVELOPE, 'frame must be a JSON object');

  // Strict envelope.
  const invalidEnvelope = (message: string) => fail(codes.INVALID_ENVELOPE, message);
  assertOnlyKeys(value, ['protocol', 'version', 'requestId', 'kind', 'payload'], invalidEnvelope);
  for (const key of ['requestId', 'kind', 'payload']) {
    if (!Object.hasOwn(value, key)) throw invalidEnvelope(`missing field \`${key}\``);
  }
  if (typeof value.requestId !== 'string') throw invalidEnvelope('requestId must be a string');
  if (!isRequestId(value.requestId)) {
    throw invalidEnvelope('requestId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  }
  if (typeof value.kind !== 'string') throw invalidEnvelope('kind must be a string');
  if (!isPlainObject(value.payload)) throw invalidEnvelope('payload must be an object');

  switch (value.kind) {
    case KIND_HELLO: {
      if (Object.keys(value.payload).length !== 0) {
        throw fail(codes.INVALID_PAYLOAD, 'hello takes an empty object payload');
      }
      return { requestId: value.requestId, kind: 'hello' };
    }
    case KIND_WORKFLOW_SIGNAL_SUBMIT: {
      try {
        const payload = decodeWorkflowSignalSubmit(value.payload);
        return { requestId: value.requestId, kind: 'workflow.signal.submit', payload };
      } catch (error) {
        if (error instanceof ProtocolError) {
          throw new DecodeFailure(requestId, kind, responseVersion, error);
        }
        throw error;
      }
    }
    case KIND_WORKFLOW_SIGNAL_RECONCILE: {
      try {
        const payload = decodeWorkflowSignalReconcile(value.payload);
        return { requestId: value.requestId, kind: 'workflow.signal.reconcile', payload };
      } catch (error) {
        if (error instanceof ProtocolError) {
          throw new DecodeFailure(requestId, kind, responseVersion, error);
        }
        throw error;
      }
    }
    default:
      throw fail(codes.UNKNOWN_KIND, `kind "${value.kind}" is not registered`);
  }
}

/** Encodes a request as one line (no trailing newline). */
export function encodeRequest(request: Request): string {
  const invalidEnvelope = (message: string) => new ProtocolError(codes.INVALID_ENVELOPE, message);
  assertClosedObject(request, ['requestId', 'kind', 'payload'], invalidEnvelope, 'request');
  const requestId = ownDataValue(request, 'requestId', invalidEnvelope, 'request');
  const kind = ownDataValue(request, 'kind', invalidEnvelope, 'request');
  if (!isRequestId(requestId)) {
    throw invalidEnvelope('requestId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  }
  if (typeof kind !== 'string') throw invalidEnvelope('kind must be a string');

  let payload: Record<string, unknown>;
  if (kind === KIND_HELLO) {
    assertClosedObject(request, ['requestId', 'kind'], invalidEnvelope, 'request');
    payload = {};
  } else if (kind === KIND_WORKFLOW_SIGNAL_SUBMIT) {
    const source = ownDataValue(request, 'payload', invalidEnvelope, 'request');
    payload = encodeWorkflowSignalSubmit(decodeWorkflowSignalSubmit(source));
  } else if (kind === KIND_WORKFLOW_SIGNAL_RECONCILE) {
    const source = ownDataValue(request, 'payload', invalidEnvelope, 'request');
    payload = encodeWorkflowSignalReconcile(decodeWorkflowSignalReconcile(source));
  } else {
    throw new ProtocolError(codes.UNKNOWN_KIND, `kind "${kind}" is not registered`);
  }
  const frame = JSON.stringify({
    protocol: PROTOCOL_NAME,
    version: kind === KIND_HELLO ? BOOTSTRAP_ENVELOPE_VERSION : PROTOCOL_VERSION,
    requestId,
    kind,
    payload,
  });
  return finishRequestFrame(frame);
}

/** Package-internal final request guard used by the production encoder and focused tests. */
export function finishRequestFrame(frame: string): string {
  const size = byteLength(frame);
  if (size > MAX_REQUEST_BYTES) {
    throw new ProtocolError(
      codes.REQUEST_TOO_LARGE,
      `request is ${size} bytes; at most ${MAX_REQUEST_BYTES} allowed`,
    );
  }
  return frame;
}

/** Encodes a response as one line (no trailing newline). */
export function encodeResponse(response: Response): string {
  const invalidEnvelope = (message: string) => new ProtocolError(codes.INVALID_ENVELOPE, message);
  assertClosedObject(
    response,
    ['version', 'requestId', 'kind', 'body'],
    invalidEnvelope,
    'response',
  );
  const versionSource = ownDataValue(response, 'version', invalidEnvelope, 'response');
  assertClosedObject(versionSource, ['axis', 'version'], invalidEnvelope, 'response.version');
  const axis = ownDataValue(versionSource, 'axis', invalidEnvelope, 'response.version');
  const wireVersion = ownDataValue(versionSource, 'version', invalidEnvelope, 'response.version');
  if (
    (axis !== 'bootstrap' && axis !== 'accepted-operation') ||
    typeof wireVersion !== 'number' ||
    !Number.isInteger(wireVersion) ||
    wireVersion < 1 ||
    wireVersion > MAX_VERSION ||
    (axis === 'bootstrap' && wireVersion !== BOOTSTRAP_ENVELOPE_VERSION)
  ) {
    throw invalidEnvelope('response.version must name the exact selected current version axis');
  }
  const requestId = ownDataValue(response, 'requestId', invalidEnvelope, 'response');
  const kind = ownDataValue(response, 'kind', invalidEnvelope, 'response');
  if (requestId !== null && !isRequestId(requestId)) {
    throw invalidEnvelope('requestId must be null or match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  }
  if (kind !== null && (typeof kind !== 'string' || !isWellFormedUnicode(kind))) {
    throw invalidEnvelope('kind must be null or a well-formed Unicode string');
  }
  const body = ownDataValue(response, 'body', invalidEnvelope, 'response');
  assertClosedObject(body, ['type', 'info', 'result', 'error'], invalidEnvelope, 'response.body');
  const type = ownDataValue(body, 'type', invalidEnvelope, 'response.body');
  const base = {
    protocol: PROTOCOL_NAME,
    version: wireVersion,
    requestId,
    kind,
  };
  let frame: string;
  switch (type) {
    case 'hello': {
      assertClosedObject(body, ['type', 'info'], invalidEnvelope, 'response.body');
      if (axis !== 'bootstrap' || kind !== KIND_HELLO) {
        throw invalidEnvelope('hello success requires hello kind and bootstrap version');
      }
      const info = decodeHelloInfo(ownDataValue(body, 'info', invalidEnvelope, 'response.body'));
      frame = JSON.stringify({ ...base, ok: true, payload: info });
      break;
    }
    case 'workflow.signal': {
      assertClosedObject(body, ['type', 'result'], invalidEnvelope, 'response.body');
      if (axis !== 'accepted-operation' || kind !== KIND_WORKFLOW_SIGNAL_SUBMIT) {
        throw invalidEnvelope('submit success requires submit kind and accepted-operation version');
      }
      const result = decodeSignalResult(
        ownDataValue(body, 'result', invalidEnvelope, 'response.body'),
      );
      frame = JSON.stringify({ ...base, ok: true, payload: result });
      break;
    }
    case 'workflow.signal.reconciliation': {
      assertClosedObject(body, ['type', 'result'], invalidEnvelope, 'response.body');
      if (axis !== 'accepted-operation' || kind !== KIND_WORKFLOW_SIGNAL_RECONCILE) {
        throw invalidEnvelope(
          'reconcile success requires reconcile kind and accepted-operation version',
        );
      }
      const result = decodeReconciliationResult(
        ownDataValue(body, 'result', invalidEnvelope, 'response.body'),
      );
      frame = JSON.stringify({ ...base, ok: true, payload: result });
      break;
    }
    case 'error': {
      assertClosedObject(body, ['type', 'error'], invalidEnvelope, 'response.body');
      const source = ownDataValue(body, 'error', invalidEnvelope, 'response.body');
      if (!isAuthenticProtocolError(source)) {
        throw invalidEnvelope('error must be an authentic direct ProtocolError instance');
      }
      const codeDescriptor = Object.getOwnPropertyDescriptor(source, 'code');
      if (codeDescriptor === undefined || !('value' in codeDescriptor)) {
        throw invalidEnvelope('error.code must be an own data property');
      }
      if (!isShortErrorCode(codeDescriptor.value)) {
        throw invalidEnvelope('error.code must match ^[A-Z][A-Z0-9_]{0,63}$');
      }
      const messageDescriptor = Object.getOwnPropertyDescriptor(source, 'message');
      if (
        messageDescriptor === undefined ||
        !('value' in messageDescriptor) ||
        typeof messageDescriptor.value !== 'string' ||
        !isWellFormedUnicode(messageDescriptor.value)
      ) {
        throw invalidEnvelope('error.message must be an own well-formed string data property');
      }
      frame = JSON.stringify({
        ...base,
        ok: false,
        error: { code: codeDescriptor.value, message: messageDescriptor.value },
      });
      break;
    }
    default:
      throw invalidEnvelope('response.body.type is not registered');
  }
  return finishResponseFrame(frame);
}

function finishResponseFrame(frame: string): string {
  const size = byteLength(frame);
  if (size > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      codes.INVALID_ENVELOPE,
      `response is ${size} bytes; at most ${MAX_FRAME_BYTES} allowed`,
    );
  }
  return frame;
}

/** Decodes one response frame, retaining correlation and expected version stage on failure. */
export function decodeResponse(
  frame: Uint8Array | string,
  context: ResponseDecodeContext = {},
): Response {
  const initialAxis = context.requestAxis ?? 'bootstrap';
  const initialVersion: ResponseVersion = {
    axis: initialAxis,
    version:
      initialAxis === 'bootstrap'
        ? (context.bootstrapVersion ?? BOOTSTRAP_ENVELOPE_VERSION)
        : (context.operationVersion ?? PROTOCOL_VERSION),
  };
  const unaddressed = (code: string, message: string) =>
    new DecodeFailure(null, null, initialVersion, new ProtocolError(code, message));
  const size = byteLength(frame);
  if (size > MAX_FRAME_BYTES) {
    throw unaddressed(
      codes.INVALID_ENVELOPE,
      `response is ${size} bytes; at most ${MAX_FRAME_BYTES} allowed`,
    );
  }
  let text: string;
  try {
    text = decodeFrame(frame);
  } catch (error) {
    throw unaddressed(codes.INVALID_ENVELOPE, `frame is not JSON: ${(error as Error).message}`);
  }
  const scan = scanJsonTokens(text);
  const probe = foldedProbe(scan.probeText);
  if (probe === null) throw unaddressed(codes.INVALID_ENVELOPE, 'frame must be a JSON object');
  const recovered = correlationFromFolded(probe);
  const probedCode =
    isPlainObject(probe.error) && isShortErrorCode(probe.error.code) ? probe.error.code : undefined;
  const bootstrapCode =
    probedCode !== undefined &&
    new Set<string>([
      codes.REQUEST_TOO_LARGE,
      codes.PROTOCOL_VERSION_UNSUPPORTED,
      codes.HANDLER_TIMEOUT,
    ]).has(probedCode);
  const axis: ResponseVersion['axis'] = bootstrapCode
    ? 'bootstrap'
    : (context.requestAxis ??
      (recovered.kind !== null && recovered.kind !== KIND_HELLO
        ? 'accepted-operation'
        : 'bootstrap'));
  const expectedVersion =
    axis === 'bootstrap'
      ? (context.bootstrapVersion ?? BOOTSTRAP_ENVELOPE_VERSION)
      : (context.operationVersion ?? PROTOCOL_VERSION);
  const responseVersion: ResponseVersion = { axis, version: expectedVersion };
  const fail = (code: string, message: string) =>
    new DecodeFailure(
      recovered.requestId,
      recovered.kind,
      responseVersion,
      new ProtocolError(code, message),
    );
  if (scan.failure !== null) {
    throw fail(
      scan.failure.kind === 'noncanonical-number' && scan.failure.inPayload
        ? codes.INVALID_PAYLOAD
        : codes.INVALID_ENVELOPE,
      scan.failure.message,
    );
  }
  if (probe.protocol !== PROTOCOL_NAME) {
    throw fail(codes.INVALID_ENVELOPE, `protocol must be "${PROTOCOL_NAME}"`);
  }
  const wireVersion = parseVersionToken(scan.topLevelNumbers.get('version'));
  if (wireVersion === null) {
    throw fail(codes.INVALID_ENVELOPE, `version must be an integer between 0 and ${MAX_VERSION}`);
  }
  if (wireVersion !== expectedVersion) {
    throw fail(
      codes.PROTOCOL_VERSION_UNSUPPORTED,
      `${axis} response version must be ${expectedVersion}; got ${wireVersion}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw fail(codes.INVALID_ENVELOPE, `frame is not JSON: ${(error as Error).message}`);
  }
  const invalidEnvelope = (message: string) => fail(codes.INVALID_ENVELOPE, message);
  if (!isPlainObject(value)) throw invalidEnvelope('frame must be a JSON object');
  assertOnlyKeys(
    value,
    ['protocol', 'version', 'requestId', 'kind', 'ok', 'payload', 'error'],
    invalidEnvelope,
  );
  if (value.protocol !== PROTOCOL_NAME)
    throw invalidEnvelope(`protocol must be "${PROTOCOL_NAME}"`);
  for (const key of ['requestId', 'kind', 'ok']) {
    if (!Object.hasOwn(value, key)) throw invalidEnvelope(`missing field \`${key}\``);
  }
  const { requestId, kind, ok } = value;
  if (requestId !== null && !isRequestId(requestId)) {
    throw invalidEnvelope('requestId must be null or match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  }
  if (kind !== null && typeof kind !== 'string')
    throw invalidEnvelope('kind must be a string or null');
  if (typeof ok !== 'boolean') throw invalidEnvelope('ok must be a boolean');

  const hasPayload = Object.hasOwn(value, 'payload');
  const hasError = Object.hasOwn(value, 'error');
  if (ok && hasPayload && !hasError) {
    switch (kind) {
      case KIND_HELLO:
        if (axis !== 'bootstrap') {
          throw fail(codes.PROTOCOL_VERSION_UNSUPPORTED, 'hello response requires bootstrap axis');
        }
        try {
          return {
            version: { axis, version: wireVersion },
            requestId,
            kind,
            body: { type: 'hello', info: decodeHelloInfo(value.payload) },
          };
        } catch (error) {
          if (error instanceof ProtocolError) throw fail(error.code, error.message);
          throw error;
        }
      case KIND_WORKFLOW_SIGNAL_SUBMIT:
        if (axis !== 'accepted-operation') {
          throw fail(codes.PROTOCOL_VERSION_UNSUPPORTED, 'submit response requires operation axis');
        }
        try {
          return {
            version: { axis, version: wireVersion },
            requestId,
            kind,
            body: { type: 'workflow.signal', result: decodeSignalResult(value.payload) },
          };
        } catch (error) {
          if (error instanceof ProtocolError) throw fail(error.code, error.message);
          throw error;
        }
      case KIND_WORKFLOW_SIGNAL_RECONCILE:
        if (axis !== 'accepted-operation') {
          throw fail(
            codes.PROTOCOL_VERSION_UNSUPPORTED,
            'reconcile response requires operation axis',
          );
        }
        try {
          return {
            version: { axis, version: wireVersion },
            requestId,
            kind,
            body: {
              type: 'workflow.signal.reconciliation',
              result: decodeReconciliationResult(value.payload),
            },
          };
        } catch (error) {
          if (error instanceof ProtocolError) throw fail(error.code, error.message);
          throw error;
        }
      case null:
        throw invalidEnvelope('successful responses must name their kind');
      default:
        throw fail(codes.UNKNOWN_KIND, `kind "${kind}" is not registered`);
    }
  }
  if (!ok && hasError && !hasPayload) {
    const error = value.error;
    if (!isPlainObject(error)) throw invalidEnvelope('error must be an object');
    assertOnlyKeys(error, ['code', 'message'], invalidEnvelope);
    if (!isShortErrorCode(error.code))
      throw invalidEnvelope('error.code must match ^[A-Z][A-Z0-9_]{0,63}$');
    if (typeof error.message !== 'string') throw invalidEnvelope('error.message must be a string');
    return {
      version: { axis, version: wireVersion },
      requestId,
      kind,
      body: { type: 'error', error: new ProtocolError(error.code, error.message) },
    };
  }
  throw invalidEnvelope('ok responses carry exactly payload; error responses carry exactly error');
}

/** What a process wrote to stdout, classified as exactly one byte frame or not. */
export type FrameExtraction =
  | { readonly kind: 'frame'; readonly frame: Uint8Array }
  | { readonly kind: 'empty' }
  | { readonly kind: 'extra'; readonly detail: string };

export type BoundedFrameExtraction =
  | FrameExtraction
  | { readonly kind: 'oversized'; readonly detail: string };

/**
 * A one-shot process must write exactly one non-empty body followed by LF and
 * immediate stream close. CRLF and every byte after LF are profile failures.
 * Process callers pass bytes so invalid UTF-8 remains available to the fatal
 * decoder.
 */
export function extractFrame(output: Uint8Array | string): FrameExtraction {
  const bytes = typeof output === 'string' ? encoder.encode(output) : output;
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) {
    return bytes.length === 0
      ? { kind: 'empty' }
      : { kind: 'extra', detail: 'frame is not LF-terminated' };
  }
  const frame = bytes.subarray(0, newline);
  const rest = bytes.subarray(newline + 1);
  if (frame.length === 0) return { kind: 'empty' };
  if (frame.at(-1) === 0x0d) {
    return { kind: 'extra', detail: 'CRLF is not a valid process-profile terminator' };
  }
  if (rest.length > 0) {
    return { kind: 'extra', detail: 'a byte followed the terminating LF' };
  }
  return { kind: 'frame', frame };
}

/**
 * Incrementally retain one bounded body and remember any process-profile byte
 * after LF. `extract()` is called only after process/stdout close.
 */
export class OneShotFrameCollector {
  readonly #chunks: Uint8Array[] = [];
  readonly #maxFrameBytes: number;
  #frameBytes = 0;
  #newlineSeen = false;
  #oversized = false;
  #invalidProfile = false;

  constructor(maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 0) {
      throw new Error('frame limit must be a non-negative safe integer');
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  /** False means the bytes before the terminating LF exceeded the frame bound. */
  append(chunk: Uint8Array): boolean {
    if (this.#oversized) return false;
    let cursor = 0;
    if (!this.#newlineSeen) {
      const newline = chunk.indexOf(0x0a);
      const frameEnd = newline < 0 ? chunk.length : newline;
      if (this.#frameBytes + frameEnd > this.#maxFrameBytes) {
        this.#oversized = true;
        return false;
      }
      if (frameEnd > 0) {
        this.#chunks.push(Uint8Array.from(chunk.subarray(0, frameEnd)));
        this.#frameBytes += frameEnd;
      }
      if (newline < 0) return true;
      this.#newlineSeen = true;
      cursor = newline + 1;
    }
    if (cursor < chunk.length) this.#invalidProfile = true;
    return true;
  }

  extract(): BoundedFrameExtraction {
    if (this.#oversized) {
      return {
        kind: 'oversized',
        detail: `frame exceeds ${this.#maxFrameBytes} bytes`,
      };
    }
    const frame = new Uint8Array(this.#frameBytes);
    let offset = 0;
    for (const chunk of this.#chunks) {
      frame.set(chunk, offset);
      offset += chunk.length;
    }
    if (!this.#newlineSeen) {
      return frame.length === 0
        ? { kind: 'empty' }
        : { kind: 'extra', detail: 'frame is not LF-terminated' };
    }
    if (frame.length === 0) return { kind: 'empty' };
    if (frame.at(-1) === 0x0d) {
      return {
        kind: 'extra',
        detail: 'CRLF is not a valid process-profile terminator',
      };
    }
    if (this.#invalidProfile) {
      return { kind: 'extra', detail: 'a byte followed the terminating LF' };
    }
    return { kind: 'frame', frame };
  }
}
