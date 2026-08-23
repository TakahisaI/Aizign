import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMetadataOnly, runCoreClientConformance, samplePayload } from './conformance.ts';
import { ReferenceOneShotClient } from './reference-client.ts';

test('the reference client satisfies the core-client conformance', async () => {
  await runCoreClientConformance((config) => new ReferenceOneShotClient(config));
});

test('assertMetadataOnly rejects harness identity and contents at any depth', () => {
  assertMetadataOnly(samplePayload('evt-1'));
  assert.throws(() => assertMetadataOnly({ signal: { sessionId: 'x' } }), /sessionId/);
  assert.throws(() => assertMetadataOnly([{ nested: { prompt: 'x' } }]), /prompt/);
});
