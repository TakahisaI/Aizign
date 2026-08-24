/**
 * Request and response envelopes: the one-line NDJSON frames that cross the
 * process boundary. Decoding follows the same stages as the Rust
 * implementation so both reject the same frames with the same codes.
 */

import { codes, isShortErrorCode, ProtocolError } from './error.ts';
import { decodeHelloInfo, type HelloInfo } from './hello.ts';
import { assertOnlyKeys, IDENTIFIER_PATTERN, isPlainObject } from './shape.ts';
import {
  decodeSignalResult,
  decodeWorkflowSignalSubmit,
  encodeWorkflowSignalSubmit,
  type SignalResult,
  type WorkflowSignalSubmitPayload,
} from './workflow-signal.ts';

export const PROTOCOL_NAME = 'aizu';
export const PROTOCOL_VERSION = 1;
/** Upper bound on any frame, request or response, in bytes. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Alias kept for callers that only deal with requests. */
export const MAX_REQUEST_BYTES = MAX_FRAME_BYTES;
export const KIND_HELLO = 'hello';
export const KIND_WORKFLOW_SIGNAL_SUBMIT = 'workflow.signal.submit';

export type Request =
  | { readonly requestId: string; readonly kind: 'hello' }
  | {
      readonly requestId: string;
      readonly kind: 'workflow.signal.submit';
      readonly payload: WorkflowSignalSubmitPayload;
    };

export type ResponseBody =
  | { readonly type: 'hello'; readonly info: HelloInfo }
  | { readonly type: 'workflow.signal'; readonly result: SignalResult }
  | { readonly type: 'error'; readonly error: ProtocolError };

export interface Response {
  /** Echoed request id; `null` only when the request was unrecoverable. */
  readonly requestId: string | null;
  /** Echoed kind; `null` only when the request was unrecoverable. */
  readonly kind: string | null;
  readonly body: ResponseBody;
}

/** A request that could not be decoded, with recovered correlation data. */
export class DecodeFailure extends Error {
  readonly requestId: string | null;
  readonly kind: string | null;
  readonly error: ProtocolError;

  constructor(requestId: string | null, kind: string | null, error: ProtocolError) {
    super(error.message);
    this.name = 'DecodeFailure';
    this.requestId = requestId;
    this.kind = kind;
    this.error = error;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function byteLength(frame: Uint8Array | string): number {
  return typeof frame === 'string' ? encoder.encode(frame).byteLength : frame.byteLength;
}

/**
 * Wire numbers must be canonical integer tokens (`0` or `-?[1-9][0-9]*`) —
 * the lexical space serde_json accepts for the integer fields of this
 * protocol. Any other spelling (`1.0`, `1e0`, `-0`) is replaced by a sentinel
 * no field check accepts, so it fails exactly where the field is validated,
 * with the same stable code and recovered correlation data as the Rust
 * decoder. JSON Schema operates on the data model and cannot see lexemes;
 * this is one of the two documented decoder-only rules (with the size bound).
 */
const NON_CANONICAL_NUMBER = Symbol('non-canonical number');
const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/;

type RevivedContext = { readonly source?: string };
function reviveCanonicalNumbers(_key: string, value: unknown, context?: RevivedContext): unknown {
  if (typeof value === 'number' && !CANONICAL_INTEGER.test(context?.source ?? '')) {
    return NON_CANONICAL_NUMBER;
  }
  return value;
}

function parseJson(frame: Uint8Array | string): unknown {
  const text = typeof frame === 'string' ? frame : decoder.decode(frame);
  return JSON.parse(text, reviveCanonicalNumbers as (key: string, value: unknown) => unknown);
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Decodes one request frame. Throws {@link DecodeFailure} carrying the
 * stable code and whatever `requestId` / `kind` could be recovered.
 */
export function decodeRequest(frame: Uint8Array | string): Request {
  const unaddressed = (code: string, message: string) =>
    new DecodeFailure(null, null, new ProtocolError(code, message));

  const size = byteLength(frame);
  if (size > MAX_FRAME_BYTES) {
    throw unaddressed(
      codes.REQUEST_TOO_LARGE,
      `request is ${size} bytes; at most ${MAX_FRAME_BYTES} allowed`,
    );
  }

  // Lenient probe: recover correlation data and check the version first.
  let probe: unknown;
  try {
    probe = parseJson(frame);
  } catch (error) {
    throw unaddressed(codes.INVALID_ENVELOPE, `frame is not JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(probe))
    throw unaddressed(codes.INVALID_ENVELOPE, 'frame must be a JSON object');
  const requestId = isRequestId(probe.requestId) ? probe.requestId : null;
  const kind = typeof probe.kind === 'string' ? probe.kind : null;
  const fail = (code: string, message: string) =>
    new DecodeFailure(requestId, kind, new ProtocolError(code, message));

  if (probe.protocol !== PROTOCOL_NAME) {
    throw fail(codes.INVALID_ENVELOPE, `protocol must be "${PROTOCOL_NAME}"`);
  }
  if (!isNonNegativeInteger(probe.version)) {
    throw fail(codes.INVALID_ENVELOPE, 'version must be an unsigned integer');
  }
  if (probe.version !== PROTOCOL_VERSION) {
    throw fail(
      codes.PROTOCOL_VERSION_UNSUPPORTED,
      `protocol version ${probe.version} is not supported; this implementation speaks ${PROTOCOL_VERSION}`,
    );
  }

  // Strict envelope.
  const invalidEnvelope = (message: string) => fail(codes.INVALID_ENVELOPE, message);
  assertOnlyKeys(probe, ['protocol', 'version', 'requestId', 'kind', 'payload'], invalidEnvelope);
  for (const key of ['requestId', 'kind', 'payload']) {
    if (!Object.hasOwn(probe, key)) throw invalidEnvelope(`missing field \`${key}\``);
  }
  if (typeof probe.requestId !== 'string') throw invalidEnvelope('requestId must be a string');
  if (!isRequestId(probe.requestId)) {
    throw invalidEnvelope('requestId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  }
  if (typeof probe.kind !== 'string') throw invalidEnvelope('kind must be a string');
  if (!isPlainObject(probe.payload)) throw invalidEnvelope('payload must be an object');

  switch (probe.kind) {
    case KIND_HELLO: {
      if (Object.keys(probe.payload).length !== 0) {
        throw fail(codes.INVALID_PAYLOAD, 'hello takes an empty object payload');
      }
      return { requestId: probe.requestId, kind: 'hello' };
    }
    case KIND_WORKFLOW_SIGNAL_SUBMIT: {
      try {
        const payload = decodeWorkflowSignalSubmit(probe.payload);
        return { requestId: probe.requestId, kind: 'workflow.signal.submit', payload };
      } catch (error) {
        if (error instanceof ProtocolError) throw new DecodeFailure(requestId, kind, error);
        throw error;
      }
    }
    default:
      throw fail(codes.UNKNOWN_KIND, `kind "${probe.kind}" is not registered`);
  }
}

/** Encodes a request as one line (no trailing newline). */
export function encodeRequest(request: Request): string {
  const payload = request.kind === 'hello' ? {} : encodeWorkflowSignalSubmit(request.payload);
  return JSON.stringify({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    requestId: request.requestId,
    kind: request.kind,
    payload,
  });
}

/** Encodes a response as one line (no trailing newline). */
export function encodeResponse(response: Response): string {
  const base = {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    requestId: response.requestId,
    kind: response.kind,
  };
  switch (response.body.type) {
    case 'hello':
      return JSON.stringify({ ...base, ok: true, payload: response.body.info });
    case 'workflow.signal':
      return JSON.stringify({ ...base, ok: true, payload: response.body.result });
    case 'error':
      return JSON.stringify({
        ...base,
        ok: false,
        error: { code: response.body.error.code, message: response.body.error.message },
      });
  }
}

/** Decodes one response frame. Throws {@link ProtocolError}. */
export function decodeResponse(frame: Uint8Array | string): Response {
  const invalidEnvelope = (message: string) => new ProtocolError(codes.INVALID_ENVELOPE, message);
  const size = byteLength(frame);
  if (size > MAX_FRAME_BYTES) {
    throw invalidEnvelope(`response is ${size} bytes; at most ${MAX_FRAME_BYTES} allowed`);
  }
  let value: unknown;
  try {
    value = parseJson(frame);
  } catch (error) {
    throw invalidEnvelope(`frame is not JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(value)) throw invalidEnvelope('frame must be a JSON object');
  assertOnlyKeys(
    value,
    ['protocol', 'version', 'requestId', 'kind', 'ok', 'payload', 'error'],
    invalidEnvelope,
  );
  if (value.protocol !== PROTOCOL_NAME)
    throw invalidEnvelope(`protocol must be "${PROTOCOL_NAME}"`);
  if (!isNonNegativeInteger(value.version))
    throw invalidEnvelope('version must be an unsigned integer');
  if (value.version !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      codes.PROTOCOL_VERSION_UNSUPPORTED,
      `protocol version ${value.version} is not supported`,
    );
  }
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
    if (!isPlainObject(value.payload)) throw invalidEnvelope('payload must be an object');
    switch (kind) {
      case KIND_HELLO:
        return { requestId, kind, body: { type: 'hello', info: decodeHelloInfo(value.payload) } };
      case KIND_WORKFLOW_SIGNAL_SUBMIT:
        return {
          requestId,
          kind,
          body: { type: 'workflow.signal', result: decodeSignalResult(value.payload) },
        };
      case null:
        throw invalidEnvelope('successful responses must name their kind');
      default:
        throw new ProtocolError(codes.UNKNOWN_KIND, `kind "${kind}" is not registered`);
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
      requestId,
      kind,
      body: { type: 'error', error: new ProtocolError(error.code, error.message) },
    };
  }
  throw invalidEnvelope('ok responses carry exactly payload; error responses carry exactly error');
}

/** What a process wrote to stdout, classified as exactly one frame or not. */
export type FrameExtraction =
  | { readonly kind: 'frame'; readonly frame: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'extra'; readonly detail: string };

/**
 * A one-shot process must write exactly one frame followed by a newline and
 * nothing but whitespace after it. Anything else is not a response: a second
 * frame, trailing prose, or a frame that never ended.
 */
export function extractFrame(output: string): FrameExtraction {
  const newline = output.indexOf('\n');
  if (newline < 0) {
    return output.trim().length === 0
      ? { kind: 'empty' }
      : { kind: 'extra', detail: 'frame is not newline-terminated' };
  }
  const frame = output.slice(0, newline);
  const rest = output.slice(newline + 1);
  if (rest.trim().length !== 0) {
    return { kind: 'extra', detail: 'more than one frame, or trailing content after the frame' };
  }
  return frame.trim().length === 0 ? { kind: 'empty' } : { kind: 'frame', frame };
}
