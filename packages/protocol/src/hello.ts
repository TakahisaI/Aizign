/** The `hello` handshake: what the binary speaks and can do. */

import { codes, ProtocolError } from './error.ts';
import { isPlainObject } from './shape.ts';

/** Capability advertised when `workflow.signal.submit` is available. */
export const CAPABILITY_WORKFLOW_SIGNAL_SUBMIT = 'workflow.signal.submit';

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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Decodes a `hello` payload, rejecting anything outside the closed schema. */
export function decodeHelloInfo(payload: unknown): HelloInfo {
  const fail = (message: string) => new ProtocolError(codes.INVALID_PAYLOAD, message);
  if (!isPlainObject(payload)) throw fail('hello payload must be an object');
  const allowed = ['protocolVersion', 'journalSchemaVersion', 'capabilities', 'package'];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) throw fail(`unknown field \`${key}\``);
  }
  const { protocolVersion, journalSchemaVersion, capabilities, package: pkg } = payload;
  if (!isNonNegativeInteger(protocolVersion)) throw fail('protocolVersion must be an integer');
  if (!isNonNegativeInteger(journalSchemaVersion)) {
    throw fail('journalSchemaVersion must be an integer');
  }
  if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === 'string')) {
    throw fail('capabilities must be an array of strings');
  }
  if (!isPlainObject(pkg)) throw fail('package must be an object');
  for (const key of Object.keys(pkg)) {
    if (key !== 'name' && key !== 'version') throw fail(`unknown field \`package.${key}\``);
  }
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    throw fail('package.name and package.version must be strings');
  }
  return {
    protocolVersion,
    journalSchemaVersion,
    capabilities: [...capabilities],
    package: { name: pkg.name, version: pkg.version },
  };
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
  for (const capability of required.capabilities) {
    if (!hello.capabilities.includes(capability)) {
      return { reason: 'missing_capability', detail: `binary lacks capability \`${capability}\`` };
    }
  }
  return undefined;
}
