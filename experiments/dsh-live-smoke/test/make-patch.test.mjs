// Guards the shape of the operator patch: it must override the bundle-layer
// entry that adapters/dsh/cordis.patch.yml inserts as disabled (same id and
// name), never insert a second entry with that id (#29).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'make-patch.mjs');
const bundlePatch = readFileSync(
  join(here, '..', '..', '..', 'adapters', 'dsh', 'cordis.patch.yml'),
  'utf8',
);

const baseArgs = [
  '--binary',
  '/opt/aizu/bin/aizu',
  '--state',
  '/var/lib/aizu/state',
  '--event-id',
  'evt-live-1',
  '--workflow-id',
  'wf-live',
  '--assignment-id',
  'as-live',
  '--role',
  'implementation',
  '--revision',
  'rev-live-1',
];

function generate(args) {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function bundleEntry() {
  const id = /^\s*- id: (\S+)$/m.exec(bundlePatch)?.[1];
  const name = /^\s*name: "([^"]+)"$/m.exec(bundlePatch)?.[1];
  assert.ok(id && name, 'cordis.patch.yml must declare one entry with id and name');
  return { id, name };
}

test('overrides the bundle-layer entry by id instead of inserting a duplicate', () => {
  const output = generate(baseArgs);
  const lines = output.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
  const { id, name } = bundleEntry();
  assert.equal(lines[0], `- id: ${id}`);
  assert.equal(lines[1], `  name: "${name}"`);
  assert.equal(lines[2], '  disabled: false');
  assert.equal(lines[3], '  config:');
  assert.doesNotMatch(output, /insert:/);
  assert.match(output, /^ {4}binary: "\/opt\/aizu\/bin\/aizu"$/m);
  assert.match(output, /^ {4}stateDir: "\/var\/lib\/aizu\/state"$/m);
  assert.match(output, /^ {4}timeoutMs: 15000$/m);
  assert.match(output, /^ {4}eventId: "evt-live-1"$/m);
  assert.match(output, /^ {4}role: implementation$/m);
});

test('passes an explicit timeout through', () => {
  assert.match(generate([...baseArgs, '--timeout-ms', '30000']), /^ {4}timeoutMs: 30000$/m);
});

test('rejects identifiers, roles, and timeouts the adapter would refuse', () => {
  const bad = [
    ['--event-id', 'evt live'],
    ['--role', 'reviewer'],
    ['--timeout-ms', '0'],
  ];
  for (const [key, value] of bad) {
    const args = baseArgs.map((arg, index) => (baseArgs[index - 1] === key ? value : arg));
    const result = spawnSync(
      process.execPath,
      [script, ...(key === '--timeout-ms' ? [...args, key, value] : args)],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 2, `${key}=${value} must exit 2`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^make-patch: /);
  }
});
