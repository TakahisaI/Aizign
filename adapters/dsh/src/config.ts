/**
 * Plugin configuration: where the `aizign` binary and its state live, and the
 * one assignment this plugin instance is bound to. The agent never sees or
 * supplies any of the identity; the control plane fixes it here.
 */

import {
  type ContentDigest,
  type ExpectedAssignment,
  isIdentifier,
  type Role,
} from '@aizign/protocol';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';

const INVALID_TRUSTED_CONFIG_MESSAGE = 'Aizign rejected invalid trusted signal configuration';
const ARTIFACT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHORT_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Control-plane values that the model must never select or alter. */
export interface TrustedSignalValues {
  readonly artifactRef?: string;
  readonly blockedShortErrorCode: string;
}

/** Raw configuration as DSH hands it to the plugin. */
export interface Config {
  /** Path to the `aizign` binary. */
  binary: string;
  /** `--state` directory for the control journal. */
  stateDir: string;
  /** Wall-clock bound per request in milliseconds. */
  timeoutMs?: number;
  /** Fixed identity of the terminal signal this instance accepts. */
  eventId: string;
  workflowId: string;
  assignmentId: string;
  attemptId: string;
  role: Role;
  artifactRevision: string;
  candidateDigest: ContentDigest;
  trustedSignalValues: TrustedSignalValues;
}

const ConfigShape = z.object({
  binary: z.string().required(),
  stateDir: z.string().required(),
  timeoutMs: z.number().min(1).max(600_000).default(15_000),
  eventId: z.string().required(),
  workflowId: z.string().required(),
  assignmentId: z.string().required(),
  attemptId: z.string().required(),
  role: z.union(['implementation', 'review']).required(),
  artifactRevision: z.string().required(),
  candidateDigest: z
    .object({
      algorithm: z.union(['sha256']).required(),
      hex: z.string().required(),
    })
    .required(),
  // The nested record is deliberately opaque to Schemastery. The transform
  // below inspects its descriptors before any member value is read.
  trustedSignalValues: z.any(),
});

export const Config: z<Config> = z.transform(ConfigShape, (config) => ({
  ...config,
  trustedSignalValues: validateTrustedSignalValues(config.trustedSignalValues, config.role),
})) as z<Config>;

/** The identity the plugin binds every submitted signal to. */
export interface SignalBinding {
  readonly eventId: string;
  readonly expected: ExpectedAssignment;
}

/** Validated configuration. */
export interface AdapterConfig {
  readonly binary: string;
  readonly stateDir: string;
  readonly timeoutMs: number;
  readonly binding: SignalBinding;
  readonly trustedSignalValues: TrustedSignalValues;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function invalidTrustedConfig(): HarnessError {
  return new HarnessError(INVALID_TRUSTED_CONFIG_MESSAGE, 'INVALID_EXPECTATION');
}

/**
 * Validates the caller-owned trusted bundle without invoking getters or
 * inheriting data through a prototype. The returned record is a fresh,
 * immutable copy and contains no caller-owned references.
 */
export function validateTrustedSignalValues(value: unknown, role: unknown): TrustedSignalValues {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw invalidTrustedConfig();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    keys.some((key) => !['artifactRef', 'blockedShortErrorCode'].includes(key)) ||
    !Object.hasOwn(descriptors, 'blockedShortErrorCode')
  ) {
    throw invalidTrustedConfig();
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!('value' in descriptor) || !descriptor.enumerable) throw invalidTrustedConfig();
  }

  const artifactRef = descriptors.artifactRef?.value;
  const blockedShortErrorCode = descriptors.blockedShortErrorCode?.value;
  if (
    (Object.hasOwn(descriptors, 'artifactRef') && artifactRef === undefined) ||
    (artifactRef !== undefined &&
      (typeof artifactRef !== 'string' || !ARTIFACT_REF.test(artifactRef))) ||
    typeof blockedShortErrorCode !== 'string' ||
    !SHORT_ERROR_CODE.test(blockedShortErrorCode) ||
    (role === 'implementation' && artifactRef === undefined)
  ) {
    throw invalidTrustedConfig();
  }

  return Object.freeze({
    ...(artifactRef === undefined ? {} : { artifactRef }),
    blockedShortErrorCode,
  });
}

/** Validates values the schema cannot (identifier patterns, non-empty paths). */
export function validateConfig(config: Config): AdapterConfig {
  const trustedSignalValues = validateTrustedSignalValues(config.trustedSignalValues, config.role);
  if (config.binary.trim().length === 0) throw new ConfigError('binary must be a non-empty path');
  if (config.stateDir.trim().length === 0)
    throw new ConfigError('stateDir must be a non-empty path');
  for (const field of [
    'eventId',
    'workflowId',
    'assignmentId',
    'attemptId',
    'artifactRevision',
  ] as const) {
    if (!isIdentifier(config[field])) {
      throw new ConfigError(`${field} must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`);
    }
  }
  if (
    config.candidateDigest.algorithm !== 'sha256' ||
    !/^[0-9a-f]{64}$/.test(config.candidateDigest.hex)
  ) {
    throw new ConfigError('candidateDigest must be a sha256 digest with 64 lowercase hex digits');
  }
  if (config.role !== 'implementation' && config.role !== 'review') {
    throw new ConfigError('role must be implementation or review');
  }
  const timeoutMs = config.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError('timeoutMs must be a positive integer');
  }
  return {
    binary: config.binary,
    stateDir: config.stateDir,
    timeoutMs,
    binding: {
      eventId: config.eventId,
      expected: {
        workflowId: config.workflowId,
        assignmentId: config.assignmentId,
        attemptId: config.attemptId,
        role: config.role,
        artifactRevision: config.artifactRevision,
        candidateDigest: {
          algorithm: 'sha256',
          hex: config.candidateDigest.hex,
        },
      },
    },
    trustedSignalValues,
  };
}
