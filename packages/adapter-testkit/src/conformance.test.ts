import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertMetadataOnly, samplePayload } from './conformance.ts';
import { fakeCoreExecutable } from './fake-core-path.ts';

test('assertMetadataOnly rejects harness identity and contents at any depth', () => {
  assertMetadataOnly(samplePayload('evt-1'));
  assert.throws(() => assertMetadataOnly({ signal: { sessionId: 'x' } }), /sessionId/);
  assert.throws(() => assertMetadataOnly({ providerId: 'provider-1' }), /providerId/);
  assert.throws(() => assertMetadataOnly({ deliveryId: 'delivery-1' }), /deliveryId/);
  assert.throws(() => assertMetadataOnly([{ nested: { prompt: 'x' } }]), /prompt/);
});

test('fakeCoreExecutable materializes one executable command without prefix arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-fake-core-executable-'));
  try {
    const command = fakeCoreExecutable(root);
    assert.equal(command.startsWith(root), true);
    assert.notEqual(statSync(command).mode & 0o111, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
