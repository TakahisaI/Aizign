/**
 * This adapter's core client against the fake core (every unknown path) and,
 * when `AIZIGN_BINARY` is set, against the real binary.
 */

import { test } from 'node:test';
import { runCoreClientConformance, runCoreScenarios } from '@aizign/adapter-testkit';
import { OneShotCoreClient } from '../../src/core-client/one-shot-client.ts';

test('OneShotCoreClient satisfies the core-client conformance', async () => {
  await runCoreClientConformance((config) => new OneShotCoreClient(config));
});

const binary = process.env.AIZIGN_BINARY;
test('OneShotCoreClient passes the core scenarios against the real aizign binary', {
  skip: binary === undefined ? 'set AIZIGN_BINARY to a built aizign binary' : false,
}, async () => {
  await runCoreScenarios((config) => new OneShotCoreClient(config), { command: binary ?? '' });
});
