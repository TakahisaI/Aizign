/** Materializes a repository-test executable for the fake core. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

interface FakeCoreControls {
  readonly argvLog?: string;
  readonly capabilities?: readonly string[];
  readonly fault?: string;
  readonly helloProtocolVersion?: number;
  readonly invocationLog?: string;
}

function controlExports(controls: FakeCoreControls): string {
  const values: ReadonlyArray<readonly [string, string | undefined]> = [
    ['AIZIGN_FAKE_ARGV_LOG', controls.argvLog],
    ['AIZIGN_FAKE_CAPABILITIES', controls.capabilities?.join(',')],
    ['AIZIGN_FAKE_FAULT', controls.fault],
    [
      'AIZIGN_FAKE_HELLO_PROTOCOL_VERSION',
      controls.helloProtocolVersion === undefined
        ? undefined
        : String(controls.helloProtocolVersion),
    ],
    ['AIZIGN_FAKE_INVOCATION_LOG', controls.invocationLog],
  ];
  return values
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n');
}

/** Creates a test-only executable whose caller still supplies canonical argv. */
export function fakeCoreExecutable(directory: string, controls: FakeCoreControls = {}): string {
  const extension = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
  const fakeCore = join(import.meta.dirname, `fake-core${extension}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, 'aizign-fake');
  const exports = controlExports(controls);
  writeFileSync(
    executable,
    `#!/bin/sh\n${exports}${exports.length === 0 ? '' : '\n'}exec ${shellQuote(process.execPath)} ${shellQuote(fakeCore)} "$@"\n`,
    { mode: 0o755 },
  );
  return executable;
}
