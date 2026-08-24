/**
 * `workflow.signal.submit`: the payload types and their closed decoders,
 * mirroring the rules `aizign-core` enforces so that an adapter can reject
 * a malformed signal before spawning a process.
 */

import { codes, isShortErrorCode, ProtocolError } from './error.ts';
import { ARTIFACT_REF_PATTERN, assertOnlyKeys, isIdentifier, isPlainObject } from './shape.ts';

export type Role = 'implementation' | 'review';
export const ROLES: readonly Role[] = ['implementation', 'review'];

export type SignalKind =
  | 'implementation_ready'
  | 'review_findings'
  | 'review_passed'
  | 'repair_submitted'
  | 'blocked';
export const SIGNAL_KINDS: readonly SignalKind[] = [
  'implementation_ready',
  'review_findings',
  'review_passed',
  'repair_submitted',
  'blocked',
];

/** The assignment the shell is bound to. Every signal must match it exactly. */
export interface ExpectedAssignment {
  readonly workflowId: string;
  readonly assignmentId: string;
  readonly role: Role;
  readonly artifactRevision: string;
}

/** A structured workflow signal. Optional fields are omitted, never `null`. */
export interface WorkflowSignal {
  readonly eventId: string;
  readonly workflowId: string;
  readonly assignmentId: string;
  readonly role: Role;
  readonly artifactRevision: string;
  readonly kind: SignalKind;
  readonly findingCount?: number;
  readonly artifactRef?: string;
  readonly shortErrorCode?: string;
}

export interface WorkflowSignalSubmitPayload {
  readonly expected: ExpectedAssignment;
  readonly signal: WorkflowSignal;
}

export type Disposition = 'accepted' | 'duplicate';

/** The `workflow.signal.submit` success payload. */
export interface SignalResult {
  readonly disposition: Disposition;
  readonly eventId: string;
}

const U32_MAX = 4_294_967_295;

function invalidPayload(message: string): ProtocolError {
  return new ProtocolError(codes.INVALID_PAYLOAD, message);
}

function requireString(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== 'string') throw invalidPayload(`${path}.${key} must be a string`);
  return value;
}

function requireRole(object: Record<string, unknown>, path: string): Role {
  const value = object.role;
  if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) {
    throw invalidPayload(`${path}.role must be one of ${ROLES.join(', ')}`);
  }
  return value as Role;
}

function optionalField(object: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(object, key)) return undefined;
  const value = object[key];
  if (value === null) throw invalidPayload(`${path}.${key} must be omitted rather than null`);
  return value;
}

/** Decodes the shape, then validates values the way the core does. */
export function decodeWorkflowSignalSubmit(payload: unknown): WorkflowSignalSubmitPayload {
  if (!isPlainObject(payload)) throw invalidPayload('payload must be an object');
  assertOnlyKeys(payload, ['expected', 'signal'], invalidPayload);
  const { expected, signal } = payload;
  if (!isPlainObject(expected)) throw invalidPayload('expected must be an object');
  if (!isPlainObject(signal)) throw invalidPayload('signal must be an object');

  assertOnlyKeys(
    expected,
    ['workflowId', 'assignmentId', 'role', 'artifactRevision'],
    invalidPayload,
  );
  const expectedShape = {
    workflowId: requireString(expected, 'workflowId', 'expected'),
    assignmentId: requireString(expected, 'assignmentId', 'expected'),
    role: requireRole(expected, 'expected'),
    artifactRevision: requireString(expected, 'artifactRevision', 'expected'),
  };

  assertOnlyKeys(
    signal,
    [
      'eventId',
      'workflowId',
      'assignmentId',
      'role',
      'artifactRevision',
      'kind',
      'findingCount',
      'artifactRef',
      'shortErrorCode',
    ],
    invalidPayload,
  );
  const kind = signal.kind;
  if (typeof kind !== 'string' || !(SIGNAL_KINDS as readonly string[]).includes(kind)) {
    throw invalidPayload(`signal.kind must be one of ${SIGNAL_KINDS.join(', ')}`);
  }
  const findingCount = optionalField(signal, 'findingCount', 'signal');
  if (
    findingCount !== undefined &&
    (typeof findingCount !== 'number' ||
      !Number.isInteger(findingCount) ||
      findingCount < 0 ||
      findingCount > U32_MAX)
  ) {
    throw invalidPayload('signal.findingCount must be an unsigned 32-bit integer');
  }
  const artifactRef = optionalField(signal, 'artifactRef', 'signal');
  if (artifactRef !== undefined && typeof artifactRef !== 'string') {
    throw invalidPayload('signal.artifactRef must be a string');
  }
  const shortErrorCode = optionalField(signal, 'shortErrorCode', 'signal');
  if (shortErrorCode !== undefined && typeof shortErrorCode !== 'string') {
    throw invalidPayload('signal.shortErrorCode must be a string');
  }
  const signalShape = {
    eventId: requireString(signal, 'eventId', 'signal'),
    workflowId: requireString(signal, 'workflowId', 'signal'),
    assignmentId: requireString(signal, 'assignmentId', 'signal'),
    role: requireRole(signal, 'signal'),
    artifactRevision: requireString(signal, 'artifactRevision', 'signal'),
    kind: kind as SignalKind,
    findingCount: findingCount as number | undefined,
    artifactRef: artifactRef as string | undefined,
    shortErrorCode: shortErrorCode as string | undefined,
  };

  // Values: expectation first, then the signal, in the core's order.
  const invalidExpectation = (field: string) =>
    new ProtocolError(codes.INVALID_EXPECTATION, `expected.${field}: not a stable identifier`);
  for (const field of ['workflowId', 'assignmentId', 'artifactRevision'] as const) {
    if (!isIdentifier(expectedShape[field])) throw invalidExpectation(field);
  }
  const invalidSignal = (message: string) => new ProtocolError(codes.INVALID_SIGNAL, message);
  for (const field of ['eventId', 'workflowId', 'assignmentId', 'artifactRevision'] as const) {
    if (!isIdentifier(signalShape[field]))
      throw invalidSignal(`signal.${field}: not a stable identifier`);
  }
  if (
    signalShape.artifactRef !== undefined &&
    !ARTIFACT_REF_PATTERN.test(signalShape.artifactRef)
  ) {
    throw invalidSignal('signal.artifactRef: not a bounded artifact reference');
  }
  if (signalShape.shortErrorCode !== undefined && !isShortErrorCode(signalShape.shortErrorCode)) {
    throw invalidSignal('signal.shortErrorCode: not a short error code');
  }
  validateSignalRules(signalShape, invalidSignal);

  const result: { -readonly [K in keyof WorkflowSignal]: WorkflowSignal[K] } = {
    eventId: signalShape.eventId,
    workflowId: signalShape.workflowId,
    assignmentId: signalShape.assignmentId,
    role: signalShape.role,
    artifactRevision: signalShape.artifactRevision,
    kind: signalShape.kind,
  };
  if (signalShape.findingCount !== undefined) result.findingCount = signalShape.findingCount;
  if (signalShape.artifactRef !== undefined) result.artifactRef = signalShape.artifactRef;
  if (signalShape.shortErrorCode !== undefined) result.shortErrorCode = signalShape.shortErrorCode;
  return { expected: expectedShape, signal: result };
}

/** The kind-specific rules shared with `aizign-core`. */
function validateSignalRules(
  signal: {
    readonly role: Role;
    readonly kind: SignalKind;
    readonly findingCount: number | undefined;
    readonly artifactRef: string | undefined;
    readonly shortErrorCode: string | undefined;
  },
  fail: (message: string) => ProtocolError,
): void {
  const { kind, role, findingCount, artifactRef, shortErrorCode } = signal;
  const requiredRole: Role | undefined =
    kind === 'implementation_ready' || kind === 'repair_submitted'
      ? 'implementation'
      : kind === 'review_findings' || kind === 'review_passed'
        ? 'review'
        : undefined;
  if (requiredRole !== undefined && requiredRole !== role) {
    throw fail(`${kind} requires the ${requiredRole} role`);
  }

  const carriesCount =
    kind === 'review_findings' || kind === 'review_passed' || kind === 'repair_submitted';
  if (carriesCount && findingCount === undefined) throw fail(`${kind} requires findingCount`);
  if (!carriesCount && findingCount !== undefined)
    throw fail(`${kind} does not carry findingCount`);
  if ((kind === 'review_findings' || kind === 'repair_submitted') && findingCount === 0) {
    throw fail(`${kind} requires findingCount greater than zero`);
  }
  if (kind === 'review_passed' && findingCount !== 0)
    throw fail('review_passed requires findingCount zero');

  if (kind === 'repair_submitted' && artifactRef === undefined)
    throw fail('repair_submitted requires artifactRef');
  if (kind !== 'repair_submitted' && kind !== 'review_findings' && artifactRef !== undefined) {
    throw fail(`${kind} does not carry artifactRef`);
  }

  if (kind === 'blocked' && shortErrorCode === undefined)
    throw fail('blocked requires shortErrorCode');
  if (kind !== 'blocked' && shortErrorCode !== undefined)
    throw fail(`${kind} does not carry shortErrorCode`);
}

/** Encodes a payload as a JSON-ready object, omitting absent optionals. */
export function encodeWorkflowSignalSubmit(
  payload: WorkflowSignalSubmitPayload,
): Record<string, unknown> {
  const { expected, signal } = payload;
  const encodedSignal: Record<string, unknown> = {
    eventId: signal.eventId,
    workflowId: signal.workflowId,
    assignmentId: signal.assignmentId,
    role: signal.role,
    artifactRevision: signal.artifactRevision,
    kind: signal.kind,
  };
  if (signal.findingCount !== undefined) encodedSignal.findingCount = signal.findingCount;
  if (signal.artifactRef !== undefined) encodedSignal.artifactRef = signal.artifactRef;
  if (signal.shortErrorCode !== undefined) encodedSignal.shortErrorCode = signal.shortErrorCode;
  return {
    expected: {
      workflowId: expected.workflowId,
      assignmentId: expected.assignmentId,
      role: expected.role,
      artifactRevision: expected.artifactRevision,
    },
    signal: encodedSignal,
  };
}

/** Decodes the success payload of `workflow.signal.submit`. */
export function decodeSignalResult(payload: unknown): SignalResult {
  if (!isPlainObject(payload)) throw invalidPayload('payload must be an object');
  assertOnlyKeys(payload, ['disposition', 'eventId'], invalidPayload);
  const { disposition, eventId } = payload;
  if (disposition !== 'accepted' && disposition !== 'duplicate') {
    throw invalidPayload('disposition must be accepted or duplicate');
  }
  if (!isIdentifier(eventId)) throw invalidPayload('eventId must be a stable identifier');
  return { disposition, eventId };
}
