/** Materializes a repository-test executable for the fake core. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Creates a test-only executable whose caller still supplies canonical argv. */
export function fakeCoreExecutable(directory: string): string {
  const extension = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
  const fakeCore = join(import.meta.dirname, `fake-core${extension}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, 'aizign-fake');
  writeFileSync(
    executable,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeCore)} "$@"\n`,
    { mode: 0o755 },
  );
  return executable;
}
