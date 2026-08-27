import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(
  readFileSync(new URL('./cases.json', import.meta.url), 'utf8'),
);

/** Stable case IDs assigned to one executable evidence owner. */
export function expectedProcessProfileCaseIds(owner) {
  return fixture.cases
    .filter((entry) => entry.evidence.includes(owner))
    .map((entry) => entry.id)
    .sort();
}

/**
 * Runtime evidence registry. A case is recorded only after its executable
 * assertion completes successfully; comments and static ID arrays cannot
 * satisfy this gate.
 */
export function createProcessProfileRegistry(owner) {
  const expected = new Set(expectedProcessProfileCaseIds(owner));
  assert.ok(expected.size > 0, `no process-profile cases assigned to ${owner}`);
  const executed = new Set();

  const record = (...caseIds) => {
    for (const caseId of caseIds) {
      assert.ok(expected.has(caseId), `${caseId} is not assigned to ${owner}`);
      assert.equal(executed.has(caseId), false, `${caseId} executed twice for ${owner}`);
      executed.add(caseId);
    }
  };

  return {
    /** Execute one assertion and record its case only after success. */
    async run(caseId, assertion) {
      const value = await assertion();
      record(caseId);
      return value;
    },
    /** Called by a runner immediately after its internal assertion succeeds. */
    record,
    /** Prove that the runtime execution set equals the fixture projection. */
    complete() {
      assert.deepEqual([...executed].sort(), [...expected].sort(), `${owner} execution set`);
    },
  };
}
