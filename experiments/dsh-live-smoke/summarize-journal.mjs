#!/usr/bin/env node
// Prints a metadata-only summary of an aizu state directory's journal:
// sequence, record kind, signal kind, and identity. Nothing else is in the
// journal by construction, but this script also never prints raw lines.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const state = process.argv[2];
if (!state) {
  process.stderr.write('usage: summarize-journal.mjs <state-dir>\n');
  process.exit(2);
}

const lines = readFileSync(join(state, 'workflow.jsonl'), 'utf8').split('\n').filter((line) => line.length > 0);
process.stdout.write(`${lines.length} record(s)\n`);
for (const line of lines) {
  const record = JSON.parse(line);
  const { seq, kind, signal } = record;
  process.stdout.write(
    `${String(seq).padStart(4)}  ${kind}  ${signal.kind}  workflow=${signal.workflowId} assignment=${signal.assignmentId} role=${signal.role} revision=${signal.artifactRevision} event=${signal.eventId}\n`,
  );
}
