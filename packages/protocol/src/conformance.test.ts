/**
 * The TypeScript decoder against every language-neutral fixture in
 * `spec/conformance` — the same files the Rust implementation runs.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DecodeFailure,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
} from './envelope.ts';

const root = join(import.meta.dirname, '../../../spec/conformance');

function frames(dir: string): Array<{ name: string; frame: Uint8Array }> {
  const entries = readdirSync(dir)
    .filter((file) => file.endsWith('.frame'))
    .sort()
    .map((file) => ({
      name: file.slice(0, -'.frame'.length),
      frame: new Uint8Array(readFileSync(join(dir, file))),
    }));
  assert.ok(entries.length > 0, `no fixtures in ${dir}`);
  return entries;
}

function expectation(
  dir: string,
  name: string,
): {
  code: string;
  requestId: string | null;
  kind: string | null;
  responseStage: 'bootstrap' | 'accepted-operation';
  responseVersion: number;
} {
  return JSON.parse(readFileSync(join(dir, `${name}.expect.json`), 'utf8'));
}

function json(text: string | Uint8Array): unknown {
  return JSON.parse(typeof text === 'string' ? text : new TextDecoder().decode(text));
}

test('valid requests decode and round-trip', () => {
  for (const { name, frame } of frames(join(root, 'valid/request'))) {
    const request = decodeRequest(frame);
    assert.deepEqual(json(encodeRequest(request)), json(frame), name);
  }
});

test('valid responses decode and round-trip', () => {
  for (const { name, frame } of frames(join(root, 'valid/response'))) {
    const response = decodeResponse(frame);
    assert.deepEqual(json(encodeResponse(response)), json(frame), name);
  }
});

test('invalid requests fail with the expected code and recovered ids', () => {
  const dir = join(root, 'invalid/request');
  for (const { name, frame } of frames(dir)) {
    const expected = expectation(dir, name);
    let failure: DecodeFailure | undefined;
    try {
      decodeRequest(frame);
    } catch (error) {
      assert.ok(error instanceof DecodeFailure, `${name}: threw ${String(error)}`);
      failure = error;
    }
    assert.ok(failure, `${name}: must be rejected`);
    assert.equal(failure.error.code, expected.code, `${name}: code`);
    assert.equal(failure.requestId, expected.requestId ?? null, `${name}: requestId`);
    assert.equal(failure.kind, expected.kind ?? null, `${name}: kind`);
    assert.deepEqual(
      failure.responseVersion,
      { axis: expected.responseStage, version: expected.responseVersion },
      `${name}: responseVersion`,
    );
  }
});

test('invalid responses fail with the expected code and recovered context', () => {
  const dir = join(root, 'invalid/response');
  for (const { name, frame } of frames(dir)) {
    const expected = expectation(dir, name);
    let failure: DecodeFailure | undefined;
    try {
      decodeResponse(
        frame,
        expected.responseStage === 'bootstrap'
          ? { requestAxis: 'bootstrap', bootstrapVersion: expected.responseVersion }
          : {
              requestAxis: 'accepted-operation',
              operationVersion: expected.responseVersion,
            },
      );
    } catch (thrown) {
      assert.ok(thrown instanceof DecodeFailure, `${name}: threw ${String(thrown)}`);
      failure = thrown;
    }
    assert.ok(failure, `${name}: must be rejected`);
    assert.equal(failure.error.code, expected.code, `${name}: code`);
    assert.equal(failure.requestId, expected.requestId, `${name}: requestId`);
    assert.equal(failure.kind, expected.kind, `${name}: kind`);
    assert.deepEqual(
      failure.responseVersion,
      { axis: expected.responseStage, version: expected.responseVersion },
      `${name}: responseVersion`,
    );
  }
});
