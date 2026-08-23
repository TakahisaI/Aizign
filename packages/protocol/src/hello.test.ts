import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITY_WORKFLOW_SIGNAL_SUBMIT, checkCompatibility, type HelloInfo } from './hello.ts';

const hello: HelloInfo = {
  protocolVersion: 1,
  journalSchemaVersion: 1,
  capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
  package: { name: 'aizu', version: '9.9.9' },
};

test('compatibility ignores the package version', () => {
  assert.equal(
    checkCompatibility(hello, {
      protocolVersion: 1,
      capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
    }),
    undefined,
  );
});

test('compatibility requires the protocol version and every capability', () => {
  assert.equal(
    checkCompatibility(hello, { protocolVersion: 2, capabilities: [] })?.reason,
    'protocol_version',
  );
  assert.equal(
    checkCompatibility(hello, { protocolVersion: 1, capabilities: ['workflow.other'] })?.reason,
    'missing_capability',
  );
});
