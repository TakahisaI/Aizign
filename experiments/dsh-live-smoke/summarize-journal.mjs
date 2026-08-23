#!/usr/bin/env node
// Prints a metadata-only summary of an aizu state directory's journal:
// sequence, record kind, signal kind, and identity. Nothing else is in the
// journal by construction, but this script also never prints raw lines.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const json = args.includes('--json');
const state = args.find((arg) => !arg.startsWith('--'));
if (!state) {
  process.stderr.write('usage: summarize-journal.mjs [--json] <state-dir>\n');
  process.exit(2);
}

const lines = readFileSync(join(state, 'workflow.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0);
const records = lines.map((line) => JSON.parse(line));
if (json) {
  process.stdout.write(
    `${JSON.stringify({ records: records.length, kinds: records.map((record) => record.signal.kind) })}\n`,
  );
} else {
  process.stdout.write(`${records.length} record(s)\n`);
  for (const { seq, kind, signal } of records) {
    process.stdout.write(
      `${String(seq).padStart(4)}  ${kind}  ${signal.kind}  workflow=${signal.workflowId} assignment=${signal.assignmentId} role=${signal.role} revision=${signal.artifactRevision} event=${signal.eventId}\n`,
    );
  }
}
