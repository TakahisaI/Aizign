import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMetadataOnly, samplePayload } from './conformance.ts';

test('assertMetadataOnly rejects harness identity and contents at any depth', () => {
  assertMetadataOnly(samplePayload('evt-1'));
  assert.throws(() => assertMetadataOnly({ signal: { sessionId: 'x' } }), /sessionId/);
  assert.throws(() => assertMetadataOnly({ providerId: 'provider-1' }), /providerId/);
  assert.throws(() => assertMetadataOnly({ deliveryId: 'delivery-1' }), /deliveryId/);
  assert.throws(() => assertMetadataOnly([{ nested: { prompt: 'x' } }]), /prompt/);
});
