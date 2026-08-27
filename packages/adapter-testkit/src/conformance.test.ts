import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codes, decodeResponse, PROTOCOL_VERSION } from '@aizign/protocol';
import { createProcessProfileRegistry } from '../../../spec/process/v1/fixtures/registry.mjs';
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

test('fake core preserves the operation version when unsafe kind correlation is bounded', async () => {
  const registry = createProcessProfileRegistry('adapter-testkit');
  await registry.run('kind-response-unsafe', () => {
    const root = mkdtempSync(join(tmpdir(), 'aizign-fake-core-unsafe-kind-'));
    try {
      const command = fakeCoreExecutable(join(root, 'bin'));
      const stateDir = join(root, 'state');
      const longKind = 'x'.repeat(65_000);
      const request = JSON.stringify({
        protocol: 'aizign',
        version: PROTOCOL_VERSION,
        requestId: 'req-unsafe-kind',
        kind: longKind,
        payload: {},
      });
      assert.ok(Buffer.byteLength(request) <= 65_536);
      const result = spawnSync(command, ['handle', '--state', stateDir], {
        input: `${request}\n`,
      });
      assert.equal(result.status, 0, result.stderr.toString());
      assert.equal(result.stdout.at(-1), 0x0a);
      const response = decodeResponse(result.stdout.subarray(0, -1), {
        requestAxis: 'accepted-operation',
        bootstrapVersion: 1,
        operationVersion: PROTOCOL_VERSION,
      });
      assert.deepEqual(response.version, {
        axis: 'accepted-operation',
        version: PROTOCOL_VERSION,
      });
      assert.equal(response.requestId, 'req-unsafe-kind');
      assert.equal(response.kind, null);
      assert.equal(response.body.type, 'error');
      if (response.body.type === 'error') {
        assert.equal(response.body.error.code, codes.UNKNOWN_KIND);
      }
      assert.equal(existsSync(stateDir), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  registry.complete();
});
