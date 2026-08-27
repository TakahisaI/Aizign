/**
 * Workflow signal submit/reconciliation payload types and closed decoders,
 * mirroring the rules `aizign-core` enforces so that an adapter can reject
 * a malformed signal before transport begins.
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

/** A typed content digest carried across protocol and journal boundaries. */
export interface ContentDigest {
  readonly algorithm: 'sha256';
  readonly hex: string;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** The assignment the shell is bound to. Every signal must match it exactly. */
export interface ExpectedAssignment {
  readonly workflowId: string;
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly role: Role;
  readonly artifactRevision: string;
  readonly candidateDigest: ContentDigest;
}

/** A structured workflow signal. Optional fields are omitted, never `null`. */
export interface WorkflowSignal {
  readonly eventId: string;
  readonly workflowId: string;
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly role: Role;
  readonly artifactRevision: string;
  readonly candidateDigest: ContentDigest;
  readonly kind: SignalKind;
  readonly findingCount?: number;
  readonly artifactRef?: string;
  readonly shortErrorCode?: string;
}

export interface WorkflowSignalSubmitPayload {
  readonly expected: ExpectedAssignment;
  readonly signal: WorkflowSignal;
}

/** The exact signal queried by `workflow.signal.reconcile`. */
export interface WorkflowSignalReconcilePayload {
  readonly signal: WorkflowSignal;
}

export type Disposition = 'accepted' | 'duplicate';

/** The `workflow.signal.submit` success payload. */
export interface SignalResult {
  readonly disposition: Disposition;
  readonly eventId: string;
}

export type ReconciliationDisposition = 'accepted' | 'conflict' | 'absent';

/** The `workflow.signal.reconcile` success payload. */
export interface ReconciliationResult {
  readonly disposition: ReconciliationDisposition;
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

function requireDigest(object: Record<string, unknown>, key: string, path: string): ContentDigest {
  const value = object[key];
  if (!isPlainObject(value)) throw invalidPayload(`${path}.${key} must be an object`);
  assertOnlyKeys(value, ['algorithm', 'hex'], invalidPayload);
  const algorithm = requireString(value, 'algorithm', `${path}.${key}`);
  const hex = requireString(value, 'hex', `${path}.${key}`);
  if (algorithm !== 'sha256') {
    throw invalidPayload(`${path}.${key}.algorithm must be sha256`);
  }
  return { algorithm, hex };
}

function validDigest(digest: ContentDigest): boolean {
  return digest.algorithm === 'sha256' && SHA256_HEX_PATTERN.test(digest.hex);
}

type WorkflowSignalShape = {
  readonly eventId: string;
  readonly workflowId: string;
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly role: Role;
  readonly artifactRevision: string;
  readonly candidateDigest: ContentDigest;
  readonly kind: SignalKind;
  readonly findingCount: number | undefined;
  readonly artifactRef: string | undefined;
  readonly shortErrorCode: string | undefined;
};

function decodeWorkflowSignalShape(value: unknown): WorkflowSignalShape {
  if (!isPlainObject(value)) throw invalidPayload('signal must be an object');
  assertOnlyKeys(
    value,
    [
      'eventId',
      'workflowId',
      'assignmentId',
      'attemptId',
      'role',
      'artifactRevision',
      'candidateDigest',
      'kind',
      'findingCount',
      'artifactRef',
      'shortErrorCode',
    ],
    invalidPayload,
  );
  const kind = value.kind;
  if (typeof kind !== 'string' || !(SIGNAL_KINDS as readonly string[]).includes(kind)) {
    throw invalidPayload(`signal.kind must be one of ${SIGNAL_KINDS.join(', ')}`);
  }
  const findingCount = optionalField(value, 'findingCount', 'signal');
  if (
    findingCount !== undefined &&
    (typeof findingCount !== 'number' ||
      !Number.isInteger(findingCount) ||
      findingCount < 0 ||
      findingCount > U32_MAX)
  ) {
    throw invalidPayload('signal.findingCount must be an unsigned 32-bit integer');
  }
  const artifactRef = optionalField(value, 'artifactRef', 'signal');
  if (artifactRef !== undefined && typeof artifactRef !== 'string') {
    throw invalidPayload('signal.artifactRef must be a string');
  }
  const shortErrorCode = optionalField(value, 'shortErrorCode', 'signal');
  if (shortErrorCode !== undefined && typeof shortErrorCode !== 'string') {
    throw invalidPayload('signal.shortErrorCode must be a string');
  }
  return {
    eventId: requireString(value, 'eventId', 'signal'),
    workflowId: requireString(value, 'workflowId', 'signal'),
    assignmentId: requireString(value, 'assignmentId', 'signal'),
    attemptId: requireString(value, 'attemptId', 'signal'),
    role: requireRole(value, 'signal'),
    artifactRevision: requireString(value, 'artifactRevision', 'signal'),
    candidateDigest: requireDigest(value, 'candidateDigest', 'signal'),
    kind: kind as SignalKind,
    findingCount: findingCount as number | undefined,
    artifactRef: artifactRef as string | undefined,
    shortErrorCode: shortErrorCode as string | undefined,
  };
}

function validateWorkflowSignal(signal: WorkflowSignalShape): WorkflowSignal {
  const invalidSignal = (message: string) => new ProtocolError(codes.INVALID_SIGNAL, message);
  for (const field of [
    'eventId',
    'workflowId',
    'assignmentId',
    'attemptId',
    'artifactRevision',
  ] as const) {
    if (!isIdentifier(signal[field])) {
      throw invalidSignal(`signal.${field}: not a stable identifier`);
    }
  }
  if (!validDigest(signal.candidateDigest)) {
    throw invalidSignal('signal.candidateDigest: not a supported content digest');
  }
  if (signal.artifactRef !== undefined && !ARTIFACT_REF_PATTERN.test(signal.artifactRef)) {
    throw invalidSignal('signal.artifactRef: not a bounded artifact reference');
  }
  if (signal.shortErrorCode !== undefined && !isShortErrorCode(signal.shortErrorCode)) {
    throw invalidSignal('signal.shortErrorCode: not a short error code');
  }
  validateSignalRules(signal, invalidSignal);

  const result: { -readonly [K in keyof WorkflowSignal]: WorkflowSignal[K] } = {
    eventId: signal.eventId,
    workflowId: signal.workflowId,
    assignmentId: signal.assignmentId,
    attemptId: signal.attemptId,
    role: signal.role,
    artifactRevision: signal.artifactRevision,
    candidateDigest: signal.candidateDigest,
    kind: signal.kind,
  };
  if (signal.findingCount !== undefined) result.findingCount = signal.findingCount;
  if (signal.artifactRef !== undefined) result.artifactRef = signal.artifactRef;
  if (signal.shortErrorCode !== undefined) result.shortErrorCode = signal.shortErrorCode;
  return result;
}

/** Decodes the shape, then validates values the way the core does. */
export function decodeWorkflowSignalSubmit(payload: unknown): WorkflowSignalSubmitPayload {
  if (!isPlainObject(payload)) throw invalidPayload('payload must be an object');
  assertOnlyKeys(payload, ['expected', 'signal'], invalidPayload);
  const { expected, signal } = payload;
  if (!isPlainObject(expected)) throw invalidPayload('expected must be an object');

  assertOnlyKeys(
    expected,
    ['workflowId', 'assignmentId', 'attemptId', 'role', 'artifactRevision', 'candidateDigest'],
    invalidPayload,
  );
  const expectedShape = {
    workflowId: requireString(expected, 'workflowId', 'expected'),
    assignmentId: requireString(expected, 'assignmentId', 'expected'),
    attemptId: requireString(expected, 'attemptId', 'expected'),
    role: requireRole(expected, 'expected'),
    artifactRevision: requireString(expected, 'artifactRevision', 'expected'),
    candidateDigest: requireDigest(expected, 'candidateDigest', 'expected'),
  };

  const signalShape = decodeWorkflowSignalShape(signal);

  // Values: expectation first, then the signal, in the core's order.
  const invalidExpectation = (field: string, reason: string) =>
    new ProtocolError(codes.INVALID_EXPECTATION, `expected.${field}: ${reason}`);
  for (const field of ['workflowId', 'assignmentId', 'attemptId', 'artifactRevision'] as const) {
    if (!isIdentifier(expectedShape[field])) {
      throw invalidExpectation(field, 'not a stable identifier');
    }
  }
  if (!validDigest(expectedShape.candidateDigest)) {
    throw invalidExpectation('candidateDigest', 'not a supported content digest');
  }
  const expectedResult: { -readonly [K in keyof ExpectedAssignment]: ExpectedAssignment[K] } = {
    workflowId: expectedShape.workflowId,
    assignmentId: expectedShape.assignmentId,
    attemptId: expectedShape.attemptId,
    role: expectedShape.role,
    artifactRevision: expectedShape.artifactRevision,
    candidateDigest: expectedShape.candidateDigest,
  };
  return { expected: expectedResult, signal: validateWorkflowSignal(signalShape) };
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
  return {
    expected: {
      workflowId: expected.workflowId,
      assignmentId: expected.assignmentId,
      attemptId: expected.attemptId,
      role: expected.role,
      artifactRevision: expected.artifactRevision,
      candidateDigest: expected.candidateDigest,
    },
    signal: encodeWorkflowSignal(signal),
  };
}

/** Encodes the shared closed workflow-signal DTO. */
export function encodeWorkflowSignal(signal: WorkflowSignal): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    eventId: signal.eventId,
    workflowId: signal.workflowId,
    assignmentId: signal.assignmentId,
    attemptId: signal.attemptId,
    role: signal.role,
    artifactRevision: signal.artifactRevision,
    candidateDigest: signal.candidateDigest,
    kind: signal.kind,
  };
  if (signal.findingCount !== undefined) encoded.findingCount = signal.findingCount;
  if (signal.artifactRef !== undefined) encoded.artifactRef = signal.artifactRef;
  if (signal.shortErrorCode !== undefined) encoded.shortErrorCode = signal.shortErrorCode;
  return encoded;
}

/** Decodes the reconcile payload through the same signal rules as submit. */
export function decodeWorkflowSignalReconcile(payload: unknown): WorkflowSignalReconcilePayload {
  if (!isPlainObject(payload)) throw invalidPayload('payload must be an object');
  assertOnlyKeys(payload, ['signal'], invalidPayload);
  return { signal: validateWorkflowSignal(decodeWorkflowSignalShape(payload.signal)) };
}

/** Encodes a reconciliation request payload. */
export function encodeWorkflowSignalReconcile(
  payload: WorkflowSignalReconcilePayload,
): Record<string, unknown> {
  return { signal: encodeWorkflowSignal(payload.signal) };
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

/** Decodes the success payload of `workflow.signal.reconcile`. */
export function decodeReconciliationResult(payload: unknown): ReconciliationResult {
  if (!isPlainObject(payload)) throw invalidPayload('payload must be an object');
  assertOnlyKeys(payload, ['disposition', 'eventId'], invalidPayload);
  const { disposition, eventId } = payload;
  if (disposition !== 'accepted' && disposition !== 'conflict' && disposition !== 'absent') {
    throw invalidPayload('disposition must be accepted, conflict, or absent');
  }
  if (!isIdentifier(eventId)) throw invalidPayload('eventId must be a stable identifier');
  return { disposition, eventId };
}
