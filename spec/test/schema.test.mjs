/**
 * The published JSON Schemas against every example and conformance fixture.
 *
 * The schemas under `spec/protocol/v1` and `spec/journal/v1` are the
 * contract; the Rust and TypeScript decoders and the JSONL store implement
 * it. This gate keeps the acceptance sets identical: every valid fixture and
 * example must validate, and every invalid fixture states in its expectation
 * whether the schema rejects it too. `schema: true` on an invalid fixture
 * marks a rule a JSON Schema cannot express — the frame size bound, the
 * canonical integer lexemes the decoders require (`1.0` and `1e0` are the
 * integer 1 in the JSON data model a schema sees, but not tokens the wire
 * accepts), and duplicate object members (a schema sees the folded object;
 * both decoders reject the repeated spelling lexically).
 *
 * The decoders run the same files: `crates/aizu-protocol/tests/conformance.rs`,
 * `crates/aizu-store-jsonl/tests/conformance.rs`, and
 * `packages/protocol/src/conformance.test.ts`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ajv = new Ajv2020({ allErrors: true });
for (const dir of ['spec/protocol/v1/schemas', 'spec/journal/v1/schemas']) {
  for (const file of readdirSync(join(root, dir)).sort()) {
    ajv.addSchema(JSON.parse(readFileSync(join(root, dir, file), 'utf8')));
  }
}

function validator(id) {
  const compiled = ajv.getSchema(`https://aizu.dev/spec/${id}`);
  assert.ok(compiled, `schema ${id} is registered`);
  return compiled;
}

/** One validator per fixture directory under `spec/conformance`. */
const validates = {
  request: validator('protocol/v1/request-envelope.schema.json'),
  response: validator('protocol/v1/response-envelope.schema.json'),
  journal: validator('journal/v1/record.schema.json'),
};
const directions = Object.keys(validates);

function reasons(direction) {
  return ajv.errorsText(validates[direction].errors);
}

/** Whether the text parses as JSON and validates against its schema. */
function classify(direction, path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  return validates[direction](value) === true;
}

function fixtures(kind, direction) {
  const names = readdirSync(join(root, 'spec/conformance', kind, direction))
    .filter((file) => file.endsWith('.frame'))
    .map((file) => file.slice(0, -'.frame'.length))
    .sort();
  assert.ok(names.length > 0, `no ${kind} ${direction} fixtures`);
  return names;
}

test('every protocol example validates against its envelope schema', () => {
  const dir = join(root, 'spec/protocol/v1/examples');
  const examples = readdirSync(dir).sort();
  assert.ok(examples.length > 0);
  for (const file of examples) {
    assert.ok(file.endsWith('.request.json') || file.endsWith('.response.json'), file);
    const direction = file.endsWith('.request.json') ? 'request' : 'response';
    const example = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    assert.ok(validates[direction](example), `${file}: ${reasons(direction)}`);
  }
});

test('every journal example record validates against the record schema', () => {
  const dir = join(root, 'spec/journal/v1/examples');
  const lines = readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .flatMap((file) =>
      readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => ({ file, line })),
    );
  assert.ok(lines.length > 0);
  for (const { file, line } of lines) {
    assert.ok(validates.journal(JSON.parse(line)), `${file}: ${reasons('journal')}`);
  }
});

test('every valid fixture validates against its schema', () => {
  for (const direction of directions) {
    for (const name of fixtures('valid', direction)) {
      const path = join(root, 'spec/conformance/valid', direction, `${name}.frame`);
      assert.equal(
        classify(direction, path),
        true,
        `valid/${direction}/${name} must validate: ${reasons(direction)}`,
      );
    }
  }
});

test('every invalid fixture matches the schema classification it declares', () => {
  for (const direction of directions) {
    const dir = join(root, 'spec/conformance/invalid', direction);
    for (const name of fixtures('invalid', direction)) {
      const expected = JSON.parse(readFileSync(join(dir, `${name}.expect.json`), 'utf8'));
      assert.equal(
        typeof expected.schema,
        'boolean',
        `invalid/${direction}/${name}: the expectation must declare \`schema\``,
      );
      assert.equal(
        classify(direction, join(dir, `${name}.frame`)),
        expected.schema,
        `invalid/${direction}/${name}: schema and decoder must agree (schema: true is reserved for rules a JSON Schema cannot express)`,
      );
    }
  }
});
