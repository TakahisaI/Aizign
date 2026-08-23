/**
 * The reference client against the real `aizu` binary and its JSONL
 * journal: the same scenarios the fake must pass. Skipped unless
 * `AIZU_BINARY` points at a built binary (`cargo xtask npm-check` sets it).
 */

import { test } from 'node:test';
import { runCoreScenarios } from './conformance.ts';
import { ReferenceOneShotClient } from './reference-client.ts';

const binary = process.env.AIZU_BINARY;

test('the real aizu binary passes the core scenarios through the reference client', {
  skip: binary === undefined ? 'set AIZU_BINARY to a built aizu binary' : false,
}, async () => {
  await runCoreScenarios((config) => new ReferenceOneShotClient(config), { command: binary ?? '' });
});
