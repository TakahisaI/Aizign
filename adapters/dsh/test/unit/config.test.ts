import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import {
  type Config,
  ConfigError,
  Config as ConfigSchema,
  validateConfig,
} from '../../src/config.ts';

const base: Config = {
  binary: '/opt/aizign/bin/aizign',
  stateDir: '/var/lib/aizign/state',
  eventId: 'evt-1',
  workflowId: 'wf-1',
  assignmentId: 'as-impl',
  attemptId: 'attempt-1',
  role: 'implementation',
  artifactRevision: 'rev-a',
  candidateDigest: {
    algorithm: 'sha256',
    hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  trustedSignalValues: {
    artifactRef: 'artifact:implementation',
    blockedShortErrorCode: 'BLOCKED_BY_CONTROL_PLANE',
  },
};

test('valid configuration binds identity and defaults the timeout', () => {
  const config = validateConfig(base);
  assert.equal(config.timeoutMs, 15_000);
  assert.deepEqual(config.binding, {
    eventId: 'evt-1',
    expected: {
      workflowId: 'wf-1',
      assignmentId: 'as-impl',
      attemptId: 'attempt-1',
      role: 'implementation',
      artifactRevision: 'rev-a',
      candidateDigest: {
        algorithm: 'sha256',
        hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
  });
  assert.deepEqual(config.trustedSignalValues, base.trustedSignalValues);
  assert.notStrictEqual(config.trustedSignalValues, base.trustedSignalValues);
});

function isTrustedConfigError(error: unknown): boolean {
  return (
    error instanceof HarnessError &&
    error.code === 'INVALID_EXPECTATION' &&
    error.message === 'Aizign rejected invalid trusted signal configuration' &&
    !('cause' in error)
  );
}

test('trusted values are closed, descriptor-first, role-qualified, and safe', async () => {
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    { blockedShortErrorCode: 'lowercase' },
    { artifactRef: 'bad ref', blockedShortErrorCode: 'BLOCKED' },
    { artifactRef: undefined, blockedShortErrorCode: 'BLOCKED' },
    { artifactRef: 'artifact:ok', blockedShortErrorCode: 'BLOCKED', extra: true },
    Object.create({ blockedShortErrorCode: 'BLOCKED' }),
    { artifactRef: 'artifact:ok' },
  ];
  const symbolRecord = { artifactRef: 'artifact:ok', blockedShortErrorCode: 'BLOCKED' } as Record<
    PropertyKey,
    unknown
  >;
  symbolRecord[Symbol('private')] = 'private';
  invalid.push(symbolRecord);

  let getterReads = 0;
  const accessorRecord = Object.defineProperty(
    { artifactRef: 'artifact:ok' },
    'blockedShortErrorCode',
    {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'BLOCKED';
      },
    },
  );
  invalid.push(accessorRecord);

  for (const trustedSignalValues of invalid) {
    const config = { ...base, trustedSignalValues } as Config;
    assert.throws(() => validateConfig(config), isTrustedConfigError);
    assert.throws(() => ConfigSchema(config), isTrustedConfigError);
    await assert.rejects(
      Promise.resolve().then(() => ConfigSchema['~standard'].validate(config)),
      isTrustedConfigError,
    );
  }
  assert.equal(getterReads, 0);

  assert.throws(
    () =>
      validateConfig({
        ...base,
        role: 'implementation',
        trustedSignalValues: { blockedShortErrorCode: 'BLOCKED' },
      }),
    isTrustedConfigError,
  );
  const review = validateConfig({
    ...base,
    role: 'review',
    trustedSignalValues: { blockedShortErrorCode: 'BLOCKED' },
  });
  assert.deepEqual(review.trustedSignalValues, { blockedShortErrorCode: 'BLOCKED' });
});

test('validated binding does not share the input candidate digest object', () => {
  const candidateDigest = {
    algorithm: 'sha256' as const,
    hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const config = validateConfig({ ...base, candidateDigest });

  candidateDigest.hex = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  assert.notStrictEqual(config.binding.expected.candidateDigest, candidateDigest);
  assert.equal(
    config.binding.expected.candidateDigest.hex,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
});

test('identifiers, paths, role, and timeout are validated', () => {
  assert.throws(() => validateConfig({ ...base, eventId: 'bad id' }), ConfigError);
  assert.throws(() => validateConfig({ ...base, workflowId: '' }), ConfigError);
  assert.throws(() => validateConfig({ ...base, attemptId: '' }), ConfigError);
  assert.throws(
    () =>
      validateConfig({
        ...base,
        candidateDigest: { algorithm: 'sha256', hex: 'ABC' },
      }),
    ConfigError,
  );
  assert.throws(() => validateConfig({ ...base, binary: '  ' }), ConfigError);
  assert.throws(() => validateConfig({ ...base, role: 'operator' as 'review' }), ConfigError);
  assert.throws(() => validateConfig({ ...base, timeoutMs: 0 }), ConfigError);
  assert.throws(() => validateConfig({ ...base, timeoutMs: 1.5 }), ConfigError);
});
