/**
 * This adapter's core client against the fake core (every unknown path) and,
 * when `AIZIGN_BINARY` is set, against the real binary.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fakeCoreCommand,
  runCoreClientConformance,
  runCoreScenarios,
} from '@aizign/adapter-testkit';
import { OneShotCoreClient } from '../../src/core-client/one-shot-client.ts';

test('OneShotCoreClient satisfies the core-client conformance', async () => {
  await runCoreClientConformance((config) => new OneShotCoreClient(config));
});

test('OneShotCoreClient does not inherit synthetic parent credentials', async () => {
  const credentialName = 'AIZIGN_TEST_SYNTHETIC_CREDENTIAL';
  const previous = process.env[credentialName];
  process.env[credentialName] = 'synthetic-non-secret-value';
  try {
    const fake = fakeCoreCommand();
    const client = new OneShotCoreClient({
      ...fake,
      stateDir: '.',
      timeoutMs: 2_000,
      env: { AIZIGN_FAKE_ASSERT_ENV_ABSENT: credentialName },
    });
    const outcome = await client.hello('environment-boundary');
    assert.equal(outcome.kind, 'ok');
  } finally {
    if (previous === undefined) delete process.env[credentialName];
    else process.env[credentialName] = previous;
  }
});

const binary = process.env.AIZIGN_BINARY;
test('OneShotCoreClient passes the core scenarios against the real aizign binary', {
  skip: binary === undefined ? 'set AIZIGN_BINARY to a built aizign binary' : false,
}, async () => {
  await runCoreScenarios((config) => new OneShotCoreClient(config), { command: binary ?? '' });
});
