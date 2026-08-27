import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanJsonTokens } from './json-token.ts';

test('the lexical scan rejects lone surrogates in every string token', () => {
  for (const frame of [
    String.raw`{"message":"\uD800"}`,
    String.raw`{"message":"\uDC00"}`,
    String.raw`{"\uD800":true}`,
    String.raw`{"discarded":"\uD800","discarded":"ok"}`,
  ]) {
    assert.equal(scanJsonTokens(frame).failure?.kind, 'invalid-unicode', frame);
  }
  assert.equal(scanJsonTokens(String.raw`{"message":"\uD83D\uDE00"}`).failure, null);
});

test('the lexical scan reports the first duplicate or noncanonical number in source order', () => {
  assert.equal(scanJsonTokens('{"a":1,"a":2,"b":1e0}').failure?.kind, 'duplicate-member');
  assert.equal(scanJsonTokens('{"a":1e0,"a":2}').failure?.kind, 'noncanonical-number');
  assert.equal(scanJsonTokens('{"payload":{"n":1e400}}').failure?.inPayload, true);
  assert.equal(scanJsonTokens('{"version":1e0,"payload":{}}').failure?.inPayload, false);
});

test('the probe text replaces numbers without coercing them', () => {
  const scan = scanJsonTokens(
    '{"version":2,"requestId":"req-1","kind":"workflow.future","payload":{"n":999999999999999999999999}}',
  );
  assert.equal(scan.topLevelNumbers.get('version'), '2');
  assert.deepEqual(JSON.parse(scan.probeText), {
    version: 0,
    requestId: 'req-1',
    kind: 'workflow.future',
    payload: { n: 0 },
  });
});
