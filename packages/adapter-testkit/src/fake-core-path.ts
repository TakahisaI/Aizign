/** Locates the fake core script next to this module, source or built. */

import { join } from 'node:path';

/** `command` and `args` that run the fake core under the current Node. */
export function fakeCoreCommand(): { readonly command: string; readonly args: readonly string[] } {
  const extension = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
  return { command: process.execPath, args: [join(import.meta.dirname, `fake-core${extension}`)] };
}
