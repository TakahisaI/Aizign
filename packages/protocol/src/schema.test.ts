/**
 * The JSON Schemas under `spec/` against every example and fixture (#31).
 *
 * The schemas are the published contract; the decoders (Rust and TypeScript)
 * implement it. This gate keeps the two acceptance sets identical: every
 * valid fixture and example must validate, and every invalid fixture states
 * in its expectation whether the schema rejects it too. `schema: true` on an
 * invalid fixture is reserved for rules a JSON Schema cannot express — today
 * only the frame size bound (`MAX_FRAME_BYTES`).
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

const root = join(import.meta.dirname, '../../..');
const ajv = new Ajv2020({ allErrors: true });
for (const dir of ['spec/protocol/v1/schemas', 'spec/journal/v1/schemas']) {
  for (const file of readdirSync(join(root, dir)).sort()) {
    ajv.addSchema(JSON.parse(readFileSync(join(root, dir, file), 'utf8')));
  }
}

function validator(id: string) {
  const compiled = ajv.getSchema(`https://aizu.dev/spec/${id}`);
  assert.ok(compiled, `schema ${id} is registered`);
  return compiled;
}

const validates = {
  request: validator('protocol/v1/request-envelope.schema.json'),
  response: validator('protocol/v1/response-envelope.schema.json'),
  record: validator('journal/v1/record.schema.json'),
};

function reasons(direction: 'request' | 'response' | 'record'): string {
  return ajv.errorsText(validates[direction].errors);
}

test('every protocol example validates against its envelope schema', () => {
  const dir = join(root, 'spec/protocol/v1/examples');
  const examples = readdirSync(dir).sort();
  assert.ok(examples.length > 0);
  for (const file of examples) {
    const direction = file.endsWith('.request.json') ? 'request' : 'response';
    assert.ok(file.endsWith('.request.json') || file.endsWith('.response.json'), file);
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
    assert.ok(validates.record(JSON.parse(line)), `${file}: ${reasons('record')}`);
  }
});

test('every conformance fixture matches its schema classification', () => {
  for (const direction of ['request', 'response'] as const) {
    for (const name of fixtures('valid', direction)) {
      assert.equal(
        classify(direction, join(root, 'spec/conformance/valid', direction, `${name}.frame`)),
        true,
        `valid/${direction}/${name} must validate: ${reasons(direction)}`,
      );
    }
    for (const name of fixtures('invalid', direction)) {
      const dir = join(root, 'spec/conformance/invalid', direction);
      const expected: { schema?: unknown } = JSON.parse(
        readFileSync(join(dir, `${name}.expect.json`), 'utf8'),
      );
      assert.equal(typeof expected.schema, 'boolean', `invalid/${direction}/${name}: schema key`);
      assert.equal(
        classify(direction, join(dir, `${name}.frame`)),
        expected.schema,
        `invalid/${direction}/${name}: decoder and schema must agree (schema: ${String(
          expected.schema,
        )} is reserved for rules the schema cannot express)`,
      );
    }
  }
});

function fixtures(kind: 'valid' | 'invalid', direction: 'request' | 'response'): string[] {
  const names = readdirSync(join(root, 'spec/conformance', kind, direction))
    .filter((file) => file.endsWith('.frame'))
    .map((file) => file.slice(0, -'.frame'.length))
    .sort();
  assert.ok(names.length > 0);
  return names;
}

/** Whether the frame parses as JSON and validates against the envelope schema. */
function classify(direction: 'request' | 'response', path: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  return validates[direction](value) === true;
}
