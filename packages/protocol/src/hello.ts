/** The `hello` handshake: what the binary speaks and can do. */

import { codes, ProtocolError } from './error.ts';
import { isWellFormedUnicode } from './json-token.ts';
import { arrayValues, assertClosedObject, ownDataValue } from './shape.ts';

/** Capability advertised when `workflow.signal.submit` is available. */
export const CAPABILITY_WORKFLOW_SIGNAL_SUBMIT = 'workflow.signal.submit';
/** Capability advertised when `workflow.signal.reconcile` is available. */
export const CAPABILITY_WORKFLOW_SIGNAL_RECONCILE = 'workflow.signal.reconcile';

/** Informational identity of the responding package. */
export interface PackageInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * The `hello` response payload. Adapters decide compatibility from
 * `protocolVersion` and `capabilities`, never from `package.version`.
 */
export interface HelloInfo {
  readonly protocolVersion: number;
  readonly journalSchemaVersion: number;
  readonly capabilities: readonly string[];
  readonly package: PackageInfo;
}

const U32_MAX = 4294967295;
const CAPABILITY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= U32_MAX;
}

function isCapability(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && CAPABILITY.test(value);
}

/** Package-internal validator and fresh-wire builder shared by decode and encode. */
export function buildHelloInfo(payload: unknown): HelloInfo {
  const fail = (message: string) => new ProtocolError(codes.INVALID_PAYLOAD, message);
  const allowed = ['protocolVersion', 'journalSchemaVersion', 'capabilities', 'package'];
  assertClosedObject(payload, allowed, fail, 'hello payload');
  const protocolVersion = ownDataValue(payload, 'protocolVersion', fail, 'hello payload');
  const journalSchemaVersion = ownDataValue(payload, 'journalSchemaVersion', fail, 'hello payload');
  const capabilitiesValue = ownDataValue(payload, 'capabilities', fail, 'hello payload');
  const pkg = ownDataValue(payload, 'package', fail, 'hello payload');
  if (!isVersion(protocolVersion)) {
    throw fail('protocolVersion must be an integer between 1 and 4294967295');
  }
  if (!isVersion(journalSchemaVersion)) {
    throw fail('journalSchemaVersion must be an integer between 1 and 4294967295');
  }
  const capabilities = arrayValues(capabilitiesValue, fail, 'capabilities');
  for (let index = 0; index < capabilities.length; index += 1) {
    if (!isCapability(capabilities[index])) {
      throw fail(
        'capabilities must be lowercase dot-separated names (^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$, at most 128 bytes)',
      );
    }
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (capabilities[earlier] === capabilities[index]) {
        throw fail('capabilities must not repeat');
      }
    }
  }
  assertClosedObject(pkg, ['name', 'version'], fail, 'package');
  const name = ownDataValue(pkg, 'name', fail, 'package');
  const version = ownDataValue(pkg, 'version', fail, 'package');
  if (
    typeof name !== 'string' ||
    typeof version !== 'string' ||
    !isWellFormedUnicode(name) ||
    !isWellFormedUnicode(version)
  ) {
    throw fail('package.name and package.version must be strings');
  }
  return {
    protocolVersion,
    journalSchemaVersion,
    capabilities: capabilities as string[],
    package: { name, version },
  };
}

/** Decodes a `hello` payload, rejecting anything outside the closed schema. */
export function decodeHelloInfo(payload: unknown): HelloInfo {
  return buildHelloInfo(payload);
}

/** Why a binary is not usable by this adapter. */
export interface Incompatibility {
  readonly reason: 'protocol_version' | 'missing_capability';
  readonly detail: string;
}

/**
 * Compatibility is decided by protocol version and capabilities only
 * (ADR-0003, ADR-0008). Returns `undefined` when compatible.
 */
export function checkCompatibility(
  hello: HelloInfo,
  required: { readonly protocolVersion: number; readonly capabilities: readonly string[] },
): Incompatibility | undefined {
  if (hello.protocolVersion !== required.protocolVersion) {
    return {
      reason: 'protocol_version',
      detail: `binary speaks protocol ${hello.protocolVersion}; this adapter requires ${required.protocolVersion}`,
    };
  }
  for (let requiredIndex = 0; requiredIndex < required.capabilities.length; requiredIndex += 1) {
    const capability = required.capabilities[requiredIndex];
    let present = false;
    for (let actualIndex = 0; actualIndex < hello.capabilities.length; actualIndex += 1) {
      if (hello.capabilities[actualIndex] === capability) {
        present = true;
        break;
      }
    }
    if (!present) {
      return { reason: 'missing_capability', detail: `binary lacks capability \`${capability}\`` };
    }
  }
  return undefined;
}
