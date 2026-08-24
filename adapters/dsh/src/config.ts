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
  type WorkflowSignalSubmitPayload,
} from '@aizign/protocol';
import z from '@deepseek-ai/schemastery';

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
  /** Review-findings event consumed by a repair assignment. */
  sourceEventId?: string;
}

export const Config: z<Config> = z.object({
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
  sourceEventId: z.string(),
});

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
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Validates values the schema cannot (identifier patterns, non-empty paths). */
export function validateConfig(config: Config): AdapterConfig {
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
  if (config.sourceEventId !== undefined && !isIdentifier(config.sourceEventId)) {
    throw new ConfigError('sourceEventId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  }
  if (
    config.candidateDigest.algorithm !== 'sha256' ||
    !/^[0-9a-f]{64}$/.test(config.candidateDigest.hex)
  ) {
    throw new ConfigError('candidateDigest must be a sha256 digest with 64 lowercase hex digits');
  }
  if (config.role === 'review' && config.sourceEventId !== undefined) {
    throw new ConfigError('sourceEventId is only valid for implementation repair assignments');
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
        candidateDigest: config.candidateDigest,
        ...(config.sourceEventId === undefined ? {} : { sourceEventId: config.sourceEventId }),
      },
    },
  };
}

/** The payload skeleton every submission from this binding starts from. */
export function bindingPayload(
  binding: SignalBinding,
  signal: Omit<WorkflowSignalSubmitPayload['signal'], keyof ExpectedAssignment | 'eventId'>,
): WorkflowSignalSubmitPayload {
  return {
    expected: binding.expected,
    signal: { ...binding.expected, eventId: binding.eventId, ...signal },
  };
}
