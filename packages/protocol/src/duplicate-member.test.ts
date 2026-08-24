import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findInvalidUnicode, InvalidUnicodeError } from './duplicate-member.ts';

test('the lexical scan rejects lone surrogates in every string token', () => {
  for (const frame of [
    String.raw`{"message":"\uD800"}`,
    String.raw`{"message":"\uDC00"}`,
    String.raw`{"\uD800":true}`,
    String.raw`{"discarded":"\uD800","discarded":"ok"}`,
  ]) {
    assert.ok(findInvalidUnicode(frame) instanceof InvalidUnicodeError, frame);
  }
  assert.equal(findInvalidUnicode(String.raw`{"message":"\uD83D\uDE00"}`), null);
});
