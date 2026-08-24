import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Config, ConfigError, validateConfig } from '../../src/config.ts';

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
