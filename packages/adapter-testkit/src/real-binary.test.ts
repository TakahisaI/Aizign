/**
 * The reference client against the real `aizign` binary and its JSONL
 * journal: the same scenarios the fake must pass. Skipped unless
 * `AIZIGN_BINARY` points at a built binary (`cargo xtask npm-check` sets it).
 */

import { test } from 'node:test';
import { runCoreScenarios } from './conformance.ts';
import { ReferenceOneShotClient } from './reference-client.ts';

const binary = process.env.AIZIGN_BINARY;

test('the real aizign binary passes the core scenarios through the reference client', {
  skip: binary === undefined ? 'set AIZIGN_BINARY to a built aizign binary' : false,
}, async () => {
  await runCoreScenarios((config) => new ReferenceOneShotClient(config), { command: binary ?? '' });
});
