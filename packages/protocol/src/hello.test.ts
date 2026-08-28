import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  checkCompatibility,
  decodeHelloInfo,
  type HelloInfo,
} from './hello.ts';

const hello: HelloInfo = {
  protocolVersion: 1,
  journalSchemaVersion: 1,
  capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
  package: { name: 'aizign', version: '9.9.9' },
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

test('hello decoding matches the schema: versions from 1, well-formed unique capabilities (#31)', () => {
  const base = {
    protocolVersion: 1,
    journalSchemaVersion: 1,
    capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
    package: { name: 'aizign', version: '0.1.0' },
  };
  assert.deepEqual(decodeHelloInfo(base), base);
  // Unknown but well-formed capabilities decode: a v1 client can still read a
  // newer binary's handshake and reject it in checkCompatibility.
  const future = { ...base, capabilities: ['workflow.signal.submit', 'workflow.status.read'] };
  assert.deepEqual(decodeHelloInfo(future).capabilities, future.capabilities);

  const bad = [
    { ...base, protocolVersion: 0 },
    { ...base, journalSchemaVersion: 0 },
    { ...base, protocolVersion: 4294967296 },
    { ...base, protocolVersion: 1.5 },
    { ...base, capabilities: ['Workflow.Signal'] },
    { ...base, capabilities: ['workflow..submit'] },
    { ...base, capabilities: [`w${'a'.repeat(128)}`] },
    { ...base, capabilities: ['workflow.signal.submit', 'workflow.signal.submit'] },
  ];
  for (const payload of bad) {
    assert.throws(
      () => decodeHelloInfo(payload),
      (error: { code?: string }) => error.code === 'INVALID_PAYLOAD',
      JSON.stringify(payload).slice(0, 120),
    );
  }
});

test('hello source validation does not invoke accessors', () => {
  let calls = 0;
  const hostile = Object.defineProperty({ ...hello }, 'capabilities', {
    enumerable: true,
    get: () => {
      calls += 1;
      return [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT];
    },
  });
  assert.throws(
    () => decodeHelloInfo(hostile),
    (error: { code?: string }) => error.code === 'INVALID_PAYLOAD',
  );
  assert.equal(calls, 0);
});
