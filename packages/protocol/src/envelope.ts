/**
 * Request and response envelopes: the one-line NDJSON frames that cross the
 * process boundary. Decoding follows the same stages as the Rust
 * implementation so both reject the same frames with the same codes.
 */

import {
  DuplicateMemberError,
  findDuplicateMember,
  findInvalidUnicode,
  InvalidUnicodeError,
  isWellFormedUnicode,
} from './duplicate-member.ts';
import { codes, isShortErrorCode, ProtocolError } from './error.ts';
import { decodeHelloInfo, type HelloInfo } from './hello.ts';
import { assertOnlyKeys, IDENTIFIER_PATTERN, isPlainObject } from './shape.ts';
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

function assertEncodedUnicode(frame: string): void {
  const invalidUnicode = findInvalidUnicode(frame);
  if (invalidUnicode !== null) {
    throw new ProtocolError(codes.INVALID_ENVELOPE, invalidUnicode.message);
  }
}

function decodeFrame(frame: Uint8Array | string): string {
  if (typeof frame === 'string') return frame;
  if (frame[0] === 0xef && frame[1] === 0xbb && frame[2] === 0xbf) {
    throw new SyntaxError('UTF-8 BOM is not allowed before a JSON frame');
  }
  return decoder.decode(frame);
}

/**
 * Wire numbers must be canonical integer tokens (`0` or `-?[1-9][0-9]*`) —
 * the lexical space serde_json accepts for the integer fields of this
 * protocol. Any other spelling (`1.0`, `1e0`, `-0`) is replaced by a sentinel
 * no field check accepts, so it fails exactly where the field is validated,
 * with the same stable code and recovered correlation data as the Rust
 * decoder. JSON Schema operates on the data model and cannot see lexemes;
 * this is one of the four documented decoder-only rules.
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

/**
 * Recovers correlation data the way the lenient request probe would see it
 * after folding: each field keeps its last spelling, and only a value that
 * passes its usual check is recovered.
 */
type Recovered = { requestId: string | null; kind: string | null };

function correlationFromFolded(folded: Record<string, unknown>): Recovered {
  const requestId =
    typeof folded.requestId === 'string' && IDENTIFIER_PATTERN.test(folded.requestId)
      ? folded.requestId
      : null;
  const kind = typeof folded.kind === 'string' ? folded.kind : null;
  return { requestId, kind };
}

function recoveredFromFolded(text: string): Recovered {
  try {
    if (findInvalidUnicode(text) !== null) return { requestId: null, kind: null };
    const folded = JSON.parse(
      text,
      reviveCanonicalNumbers as (key: string, value: unknown) => unknown,
    ) as Record<string, unknown>;
    return correlationFromFolded(folded);
  } catch {
    return { requestId: null, kind: null };
  }
}

function isWellFormedJsonValue(value: unknown): boolean {
  if (typeof value === 'string') return isWellFormedUnicode(value);
  if (Array.isArray(value)) return value.every(isWellFormedJsonValue);
  if (!isPlainObject(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => isWellFormedUnicode(key) && isWellFormedJsonValue(nested),
  );
}

/** Mirrors the Rust lenient probe: malformed strings in fields it reads make
 * the frame unaddressed, while malformed strings in ignored payload data do
 * not prevent recovery of an earlier valid requestId and kind. */
function recoveredFromInvalidUnicode(text: string): Recovered {
  try {
    const folded = JSON.parse(
      text,
      reviveCanonicalNumbers as (key: string, value: unknown) => unknown,
    );
    if (!isPlainObject(folded)) return { requestId: null, kind: null };
    if (Object.keys(folded).some((key) => !isWellFormedUnicode(key))) {
      return { requestId: null, kind: null };
    }
    for (const key of ['protocol', 'version', 'requestId', 'kind']) {
      if (Object.hasOwn(folded, key) && !isWellFormedJsonValue(folded[key])) {
        return { requestId: null, kind: null };
      }
    }
    return correlationFromFolded(folded);
  } catch {
    return { requestId: null, kind: null };
  }
}

function parseJson(frame: Uint8Array | string): unknown {
  const text = decodeFrame(frame);
  const invalidUnicode = findInvalidUnicode(text);
  if (invalidUnicode !== null) {
    throw invalidUnicode;
  }
  const duplicate = findDuplicateMember(text);
  if (duplicate !== null) {
    throw duplicate;
  }
  return JSON.parse(text, reviveCanonicalNumbers as (key: string, value: unknown) => unknown);
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The envelope version's accepted integer range: `PROTOCOL_VERSION` is a
 * `u32`, so versions beyond `u32::MAX` are outside the contract entirely —
 * `INVALID_ENVELOPE`, not `PROTOCOL_VERSION_UNSUPPORTED`. The Rust decoder
 * applies the same bound (`serde_json` switches to floating point above
 * `u64::MAX` and its typed `u32` field rejects it); JSON numbers are exact
 * up to `2^53`, so this comparison sees the same value.
 */
const MAX_VERSION = 4_294_967_295;

function isVersionInRange(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= MAX_VERSION;
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
    if (error instanceof DuplicateMemberError) {
      // Correlation data comes from the folded frame, so the recovery rule
      // matches every other rejection: last spelling wins when unambiguous.
      const folded = recoveredFromFolded(decodeFrame(frame));
      throw new DecodeFailure(
        folded.requestId,
        folded.kind,
        new ProtocolError(codes.INVALID_ENVELOPE, error.message),
      );
    }
    if (error instanceof InvalidUnicodeError) {
      const folded = recoveredFromInvalidUnicode(decodeFrame(frame));
      throw new DecodeFailure(
        folded.requestId,
        folded.kind,
        new ProtocolError(codes.INVALID_ENVELOPE, error.message),
      );
    }
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
  if (!isVersionInRange(probe.version)) {
    throw fail(codes.INVALID_ENVELOPE, `version must be an integer between 0 and ${MAX_VERSION}`);
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
    case KIND_WORKFLOW_SIGNAL_RECONCILE: {
      try {
        const payload = decodeWorkflowSignalReconcile(probe.payload);
        return { requestId: probe.requestId, kind: 'workflow.signal.reconcile', payload };
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
  const payload =
    request.kind === 'hello'
      ? {}
      : request.kind === 'workflow.signal.submit'
        ? encodeWorkflowSignalSubmit(request.payload)
        : encodeWorkflowSignalReconcile(request.payload);
  const frame = JSON.stringify({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    requestId: request.requestId,
    kind: request.kind,
    payload,
  });
  const size = byteLength(frame);
  if (size > MAX_REQUEST_BYTES) {
    throw new ProtocolError(
      codes.REQUEST_TOO_LARGE,
      `request is ${size} bytes; at most ${MAX_REQUEST_BYTES} allowed`,
    );
  }
  assertEncodedUnicode(frame);
  return frame;
}

/** Encodes a response as one line (no trailing newline). */
export function encodeResponse(response: Response): string {
  const base = {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    requestId: response.requestId,
    kind: response.kind,
  };
  let frame: string;
  switch (response.body.type) {
    case 'hello':
      frame = JSON.stringify({ ...base, ok: true, payload: response.body.info });
      break;
    case 'workflow.signal':
      frame = JSON.stringify({ ...base, ok: true, payload: response.body.result });
      break;
    case 'workflow.signal.reconciliation':
      frame = JSON.stringify({ ...base, ok: true, payload: response.body.result });
      break;
    case 'error':
      frame = JSON.stringify({
        ...base,
        ok: false,
        error: { code: response.body.error.code, message: response.body.error.message },
      });
      break;
  }
  const size = byteLength(frame);
  if (size > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      codes.INVALID_ENVELOPE,
      `response is ${size} bytes; at most ${MAX_FRAME_BYTES} allowed`,
    );
  }
  assertEncodedUnicode(frame);
  return frame;
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
    if (error instanceof DuplicateMemberError) throw invalidEnvelope(error.message);
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
  if (!isVersionInRange(value.version))
    throw invalidEnvelope(`version must be an integer between 0 and ${MAX_VERSION}`);
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
    switch (kind) {
      case KIND_HELLO:
        return { requestId, kind, body: { type: 'hello', info: decodeHelloInfo(value.payload) } };
      case KIND_WORKFLOW_SIGNAL_SUBMIT:
        return {
          requestId,
          kind,
          body: { type: 'workflow.signal', result: decodeSignalResult(value.payload) },
        };
      case KIND_WORKFLOW_SIGNAL_RECONCILE:
        return {
          requestId,
          kind,
          body: {
            type: 'workflow.signal.reconciliation',
            result: decodeReconciliationResult(value.payload),
          },
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
