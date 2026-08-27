import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const authorityPath = 'spec/process/v1/README.md';
const fixturePath = 'spec/process/v1/fixtures/cases.json';
const authority = readFileSync(join(root, authorityPath), 'utf8');
const fixture = JSON.parse(readFileSync(join(root, fixturePath), 'utf8'));

const evidenceSources = {
  benchmark: 'benchmarks/performance/run.test.mjs',
  dsh: 'adapters/dsh/test/conformance/core-client.test.ts',
  protocol: join('packages', 'protocol', 'src', 'envelope.test.ts'),
  'rust-cli': 'crates/aizign-cli/tests/handle.rs',
};

const allowed = {
  group: new Set(['request', 'hello', 'version-kind', 'response-process']),
  stage: new Set([
    'bootstrap-hello',
    'bootstrap-selection',
    'bounded-encoding',
    'child-framing',
    'child-handler-watchdog',
    'child-read-watchdog',
    'operation-membership',
    'operation-selection',
    'parent-caller-lifecycle',
    'parent-compatibility',
    'parent-correlation',
    'parent-lifecycle-watchdog',
    'parent-process-exit',
    'parent-process-watchdog',
    'parent-protocol',
    'parent-response-decode',
    'parent-response-framing',
    'parent-spawn',
    'parent-stdout-watchdog',
    'protocol',
  ]),
  responseVersion: new Set(['B1', 'O1', 'selected', 'decoded', 'none']),
  responseCode: new Set([
    'HANDLER_TIMEOUT',
    'INVALID_ENVELOPE',
    'PROTOCOL_VERSION_UNSUPPORTED',
    'REQUEST_TOO_LARGE',
    'UNKNOWN_KIND',
    'decoded',
    'none',
    'protocol-result',
    'success',
  ]),
  correlation: new Set([
    'null/null',
    'protocol',
    'exact',
    'mismatch',
    'safe-request/null-kind',
    'unusable',
    'none',
  ]),
  effect: new Set(['none', 'eligible', 'hello-only', 'possible']),
  parent: new Set(['unknown-no-retry', 'continue', 'incompatible-no-operation', 'semantic']),
};

test('the process fixture is a complete non-normative projection of the stable case inventory', () => {
  assert.deepEqual(Object.keys(fixture).sort(), [
    'authority',
    'cases',
    'fixtureVersion',
    'normative',
  ]);
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.authority, authorityPath);
  assert.equal(fixture.normative, false);

  const authorityIds = [...authority.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((match) => match[1]);
  const fixtureIds = fixture.cases.map((entry) => entry.id);
  assert.equal(authorityIds.length, 55);
  assert.equal(new Set(authorityIds).size, authorityIds.length);
  assert.equal(new Set(fixtureIds).size, fixtureIds.length);
  assert.deepEqual([...fixtureIds].sort(), [...authorityIds].sort());
});

test('every process fixture has a closed, metadata-only evidence record', () => {
  const expectedKeys = [
    'correlation',
    'effect',
    'evidence',
    'group',
    'id',
    'parent',
    'responseCode',
    'responseVersion',
    'stage',
    'stimulus',
  ];

  for (const entry of fixture.cases) {
    assert.deepEqual(Object.keys(entry).sort(), expectedKeys, entry.id);
    for (const key of ['id', 'stage', 'stimulus', 'responseCode']) {
      assert.match(entry[key], /^[A-Za-z0-9][A-Za-z0-9/_-]{0,95}$/, `${entry.id}.${key}`);
    }
    for (const [key, values] of Object.entries(allowed)) {
      assert.equal(values.has(entry[key]), true, `${entry.id}.${key}: ${entry[key]}`);
    }
    assert.ok(entry.evidence.length > 0, entry.id);
    assert.deepEqual([...new Set(entry.evidence)], entry.evidence, entry.id);
    for (const source of entry.evidence)
      assert.ok(source in evidenceSources, `${entry.id}: ${source}`);
  }

  assert.ok(Buffer.byteLength(JSON.stringify(fixture)) <= 65_536);
  assert.equal(
    /credential|password|prompt|model-output|reasoning/i.test(JSON.stringify(fixture)),
    false,
  );
});

test('each projected case is declared by every applicable executable test owner', () => {
  const sourceText = Object.fromEntries(
    Object.entries(evidenceSources).map(([owner, path]) => [
      owner,
      readFileSync(join(root, path), 'utf8'),
    ]),
  );

  for (const entry of fixture.cases) {
    for (const owner of entry.evidence) {
      assert.ok(sourceText[owner].includes(entry.id), `${entry.id} missing from ${owner}`);
    }
  }
});
