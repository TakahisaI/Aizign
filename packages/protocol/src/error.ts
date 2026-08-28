/**
 * Protocol-level errors and the stable short codes they carry. Workflow
 * rejections reuse the codes defined by `aizign-core`.
 */

import { isProxyValue } from './shape.ts';

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
  WORKFLOW_MISMATCH: 'WORKFLOW_MISMATCH',
  ASSIGNMENT_MISMATCH: 'ASSIGNMENT_MISMATCH',
  ATTEMPT_MISMATCH: 'ATTEMPT_MISMATCH',
  ROLE_MISMATCH: 'ROLE_MISMATCH',
  REVISION_MISMATCH: 'REVISION_MISMATCH',
  CANDIDATE_DIGEST_MISMATCH: 'CANDIDATE_DIGEST_MISMATCH',
  EVENT_CONFLICT: 'EVENT_CONFLICT',
  JOURNAL_UNAVAILABLE: 'JOURNAL_UNAVAILABLE',
  JOURNAL_CORRUPT: 'JOURNAL_CORRUPT',
  JOURNAL_SCHEMA_UNSUPPORTED: 'JOURNAL_SCHEMA_UNSUPPORTED',
  JOURNAL_LOCKED: 'JOURNAL_LOCKED',
  JOURNAL_BOUND_EXCEEDED: 'JOURNAL_BOUND_EXCEEDED',
  JOURNAL_OUTCOME_UNKNOWN: 'JOURNAL_OUTCOME_UNKNOWN',
} as const;

/** Whether `value` is a well-formed short error code. */
export function isShortErrorCode(value: unknown): value is string {
  return typeof value === 'string' && SHORT_ERROR_CODE_PATTERN.test(value);
}

/**
 * A protocol-boundary error carrying a stable code and an operational
 * diagnostic. It
 * may represent a decoded wire error, a local encode/validation failure, or a
 * workflow rejection. The message is not a model-safe field and may contain
 * state-path or operating-system detail; adapters must normalize it before a
 * model-facing boundary. Construction rejects malformed raw codes; operation
 * clients decide whether they recognize a well-formed code's semantics.
 */
interface ProtocolErrorSnapshot {
  readonly code: string;
  readonly message: string;
}

const authenticProtocolErrors = new WeakMap<object, ProtocolErrorSnapshot>();

export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    if (!isShortErrorCode(code)) throw new TypeError('Protocol error code is malformed');
    if (typeof message !== 'string') throw new TypeError('Protocol error message must be a string');
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    if (new.target === ProtocolError) {
      authenticProtocolErrors.set(this, { code, message });
    }
  }
}

/** Internal check for the sole sanctioned non-plain response source value. */
export function isAuthenticProtocolError(value: unknown): value is ProtocolError {
  if (
    typeof value !== 'object' ||
    value === null ||
    isProxyValue(value) ||
    Object.getPrototypeOf(value) !== ProtocolError.prototype
  ) {
    return false;
  }
  const snapshot = authenticProtocolErrors.get(value);
  if (snapshot === undefined) return false;
  const code = Object.getOwnPropertyDescriptor(value, 'code');
  const message = Object.getOwnPropertyDescriptor(value, 'message');
  return (
    code !== undefined &&
    'value' in code &&
    code.value === snapshot.code &&
    message !== undefined &&
    'value' in message &&
    message.value === snapshot.message
  );
}
