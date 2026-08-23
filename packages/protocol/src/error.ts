/**
 * Protocol-level errors and the stable short codes they carry. Workflow
 * rejections reuse the codes defined by `aizu-core`.
 */

/** `^[A-Z][A-Z0-9_]{0,63}$` */
export const SHORT_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Stable short error codes emitted at the protocol boundary. */
export const codes = {
  PROTOCOL_VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED',
  INVALID_ENVELOPE: 'INVALID_ENVELOPE',
  UNKNOWN_KIND: 'UNKNOWN_KIND',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',
  CAPABILITY_UNSUPPORTED: 'CAPABILITY_UNSUPPORTED',
  INTERNAL: 'INTERNAL',
  HANDLER_TIMEOUT: 'HANDLER_TIMEOUT',
  INVALID_EXPECTATION: 'INVALID_EXPECTATION',
  INVALID_SIGNAL: 'INVALID_SIGNAL',
} as const;

/** Whether `value` is a well-formed short error code. */
export function isShortErrorCode(value: unknown): value is string {
  return typeof value === 'string' && SHORT_ERROR_CODE_PATTERN.test(value);
}

/**
 * A response-level error: a stable code plus a message that never contains
 * request content. Construct with a registered code; anything else degrades
 * to `INTERNAL` so a malformed code cannot reach the wire.
 */
export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = isShortErrorCode(code) ? code : codes.INTERNAL;
  }
}
