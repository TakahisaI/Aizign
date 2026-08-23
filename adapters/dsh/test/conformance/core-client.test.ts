/**
 * This adapter's core client against the fake core (every unknown path) and,
 * when `AIZU_BINARY` is set, against the real binary.
 */

import { test } from 'node:test';
import { runCoreClientConformance, runCoreScenarios } from '@aizu/adapter-testkit';
import { OneShotCoreClient } from '../../src/core-client/one-shot-client.ts';

test('OneShotCoreClient satisfies the core-client conformance', async () => {
  await runCoreClientConformance((config) => new OneShotCoreClient(config));
});

const binary = process.env.AIZU_BINARY;
test('OneShotCoreClient passes the core scenarios against the real aizu binary', {
  skip: binary === undefined ? 'set AIZU_BINARY to a built aizu binary' : false,
}, async () => {
  await runCoreScenarios((config) => new OneShotCoreClient(config), { command: binary ?? '' });
});
