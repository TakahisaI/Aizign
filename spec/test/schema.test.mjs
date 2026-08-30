/**
 * The published JSON Schemas against every example and conformance fixture.
 *
 * The schemas under `spec/protocol/v1`, `spec/journal/v1`, and the historical
 * `spec/store/v1` plus current/target `spec/store/v2` authority packages and
 * the accepted-not-yet-implemented `spec/dsh/lifecycle/v1` authority package
 * are the contract; the Rust and TypeScript decoders and the JSONL store
 * implement the applicable current runtime version. This gate keeps the acceptance sets identical: every valid fixture and
 * example must validate, and every invalid fixture states in its expectation
 * whether the schema rejects it too. `schema: true` on an invalid fixture
 * marks a rule a JSON Schema cannot express — the frame size bound, the
 * canonical integer lexemes the decoders require (`1.0` and `1e0` are the
 * integer 1 in the JSON data model a schema sees, but not tokens the wire
 * accepts), duplicate object members (a schema sees the folded object), and
 * lone UTF-16 surrogates (JavaScript strings can retain them). The applicable
 * protocol decoders and store reader reject those lexical forms before
 * interpreting the document.
 *
 * The decoders run the same files: `crates/aizign-protocol/tests/conformance.rs`,
 * `crates/aizign-store-jsonl/tests/conformance.rs`, and
 * `packages/protocol/src/conformance.test.ts`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ajv = new Ajv2020({ allErrors: true });
for (const dir of [
  'spec/protocol/v1/schemas',
  'spec/journal/v1/schemas',
  'spec/store/v1/schemas',
  'spec/store/v2/schemas',
  'spec/store/v2/fixtures',
  'spec/classification',
  'spec/dsh/lifecycle/v1/schemas',
]) {
  for (const file of readdirSync(join(root, dir))
    .filter((file) => file.endsWith('.schema.json'))
    .sort()) {
    ajv.addSchema(JSON.parse(readFileSync(join(root, dir, file), 'utf8')));
  }
}

function validator(id) {
  const compiled = ajv.getSchema(`https://aizign.dev/spec/${id}`);
  assert.ok(compiled, `schema ${id} is registered`);
  return compiled;
}

/** One validator per fixture directory under `spec/conformance`. */
const validates = {
  request: validator('protocol/v1/request-envelope.schema.json'),
  response: validator('protocol/v1/response-envelope.schema.json'),
  journal: validator('journal/v1/record.schema.json'),
  store: validator('store/v2/commit.schema.json'),
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

test('every store metadata example validates against the commit schema', () => {
  const validate = validator('store/v1/commit.schema.json');
  const dir = join(root, 'spec/store/v1/examples');
  const examples = readdirSync(dir).filter((file) => file.endsWith('.json'));
  assert.ok(examples.length > 0);
  for (const file of examples) {
    const value = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    assert.ok(validate(value), `${file}: ${ajv.errorsText(validate.errors)}`);
  }
});

const storeV2CaseIds = [
  'init-fresh-clean',
  'init-pre-marker-partial',
  'init-commit-marker-no-witness',
  'init-prepared-rebarrier-success',
  'init-prepared-file-sync-dir-sync-failure-same-boot',
  'init-prepared-rebarrier-inode-replaced',
  'init-clean-final-sync-failure-visible',
  'init-clean-missing-commit',
  'init-prepared-nonempty-journal',
  'init-v1-commit',
  'init-unknown-version',
  'init-malformed-witness',
  'append-clean-generation',
  'append-prepared-old-commit-old-journal',
  'append-prepared-old-commit-partial-journal',
  'append-prepared-old-commit-new-journal',
  'append-prepared-new-commit-new-journal',
  'append-clean-tail',
  'append-clean-digest-mismatch',
  'append-generation-gap',
  'append-reverse-witness',
  'append-bound-generation-10001',
  'append-visible-clean-final-sync-failure',
  'profile-ext4-rw-pass',
  'profile-shared-magic-non-ext4-fail',
  'profile-mount-id-missing-fail',
  'profile-mountinfo-ambiguous-fail',
  'profile-per-mount-ro-fail',
  'profile-superblock-ro-fail',
  'profile-parent-child-mount-mismatch-fail',
  'profile-artifact-device-mismatch-fail',
  'profile-artifact-identity-replacement-fail',
  'profile-reader-unsupported-never-known',
  'profile-statx-nosys-fail',
  'revalidate-journal-byte-mutation',
  'revalidate-commit-mutation',
  'revalidate-witness-mutation',
  'revalidate-artifact-replacement',
].sort();

test('store v2 examples and cross-field relations are valid', () => {
  const commitValidate = validator('store/v2/commit.schema.json');
  const publishValidate = validator('store/v2/publish.schema.json');
  const commit = JSON.parse(
    readFileSync(join(root, 'spec/store/v2/examples/workflow.commit.json'), 'utf8'),
  );
  const publish = JSON.parse(
    readFileSync(join(root, 'spec/store/v2/examples/workflow.publish.json'), 'utf8'),
  );

  assert.ok(commitValidate(commit), ajv.errorsText(commitValidate.errors));
  assert.equal(commit.generation, commit.committedEntries + 1);
  assert.ok(publishValidate(publish), ajv.errorsText(publishValidate.errors));
  assert.equal(publish.startedGeneration, commit.generation);
  assert.equal(publish.publishedGeneration, commit.generation);
  assert.ok(
    (publish.startedGeneration === 1 && publish.publishedGeneration === 0) ||
      publish.startedGeneration === publish.publishedGeneration ||
      publish.startedGeneration === publish.publishedGeneration + 1,
  );
});

test('store v2 case corpus is closed, complete, and unique', () => {
  const validate = validator('store/v2/cases.schema.json');
  const cases = JSON.parse(readFileSync(join(root, 'spec/store/v2/fixtures/cases.json'), 'utf8'));

  assert.ok(validate(cases), ajv.errorsText(validate.errors));
  const actualIds = cases.map(({ id }) => id);
  assert.equal(new Set(actualIds).size, actualIds.length, 'store v2 case IDs must be unique');
  assert.deepEqual([...actualIds].sort(), storeV2CaseIds);
});

const dshLifecycleCaseIds = [
  'init-first-root-ready',
  'init-first-root-nonempty',
  'init-first-root-partial-discard-only',
  'init-first-marker-file-sync-failure',
  'init-first-root-dir-sync-failure',
  'init-first-events-dir-sync-failure',
  'init-event-file-sync-failure',
  'init-event-rename-failure',
  'init-event-events-dir-sync-failure',
  'init-later-event-ready',
  'init-later-event-preserves-existing',
  'init-existing-event-rejected',
  'init-root-marker-mismatch',
  'init-unexpected-artifact',
  'init-missing-state-before-preflight',
  'init-malformed-state-before-preflight',
  'init-binding-mismatch-before-preflight',
  'init-trusted-bundle-mismatch-before-preflight',
  'init-core-state-path-key-mismatch-before-preflight',
  'init-core-state-valid-replacement-trusted-limitation',
  'profile-supported',
  'profile-realpath-statfs-only-rejected',
  'profile-root-core-mount-mismatch',
  'profile-symlink-component-rejected',
  'profile-bind-subtree-rejected',
  'profile-root-replacement-rejected',
  'profile-lexical-alias-rejected',
  'profile-different-root-restart-reset-rejected',
  'profile-mountinfo-missing-rejected',
  'profile-mountinfo-ambiguous-rejected',
  'profile-mountinfo-malformed-escape-rejected',
  'profile-readonly-rejected',
  'profile-non-ext4-rejected',
  'profile-device-disagreement-rejected',
  'profile-descriptor-identity-revalidation',
  'profile-unsupported-platform',
  'lease-duplicate-context-rejected',
  'lease-duplicate-opened-identity-rejected',
  'lease-dispose-reapply-stale-handles',
  'lease-tool-disposer-failure-stale-tool',
  'submit-ready-accepted',
  'submit-ready-duplicate',
  'submit-ready-known-rejected',
  'submit-known-rejected-next-sequence',
  'submit-max-sequence-rejected',
  'submit-retained-pair-byte-identical',
  'submit-fence-before-spawn',
  'submit-concurrent-n-single-child',
  'submit-reconcile-race-single-child',
  'submit-fence-file-create-failure',
  'submit-fence-file-write-failure',
  'submit-fence-file-sync-failure',
  'submit-fence-rename-failure',
  'submit-fence-events-dir-sync-failure',
  'submit-crash-after-fence-before-spawn',
  'submit-crash-during-child',
  'submit-crash-after-core-append',
  'submit-crash-after-response-before-lifecycle',
  'submit-no-response-needs-reconciliation',
  'submit-undecodable-response-needs-reconciliation',
  'submit-oversized-response-needs-reconciliation',
  'submit-correlation-mismatch-needs-reconciliation',
  'submit-timeout-needs-reconciliation',
  'submit-spawn-failed-needs-reconciliation',
  'submit-reported-unknown-needs-reconciliation',
  'submit-aborted-needs-reconciliation',
  'submit-known-result-publication-failure',
  'submit-same-arguments-after-unknown-zero-child',
  'submit-changed-arguments-after-unknown-zero-child',
  'submit-lost-ack-real-binary-reconciled',
  'submit-retained-payload-recompute-mutant',
  'submit-lifecycle-loss-no-inmemory-ready-mutant',
  'restart-ready',
  'restart-in-flight-to-needs-reconciliation',
  'restart-known-accepted',
  'restart-known-duplicate',
  'restart-known-rejected',
  'restart-needs-reconciliation',
  'restart-reconciled-accepted',
  'restart-reconciled-conflict',
  'restart-reconciled-absent',
  'restart-still-unknown',
  'restart-missing-malformed-unsafe-fail-closed',
  'reconcile-accepted',
  'reconcile-conflict',
  'reconcile-absent-no-submit',
  'reconcile-unknown-still-unknown',
  'reconcile-concurrent-n-single-child',
  'reconcile-publication-file-write-failure',
  'reconcile-publication-file-sync-failure',
  'reconcile-publication-rename-failure',
  'reconcile-publication-events-dir-sync-failure',
  'reconcile-journal-byte-identical',
  'reconcile-never-calls-submit-mutant',
  'reconcile-absent-never-republishes-tool-mutant',
  'projection-ready-idle',
  'projection-known-rejected-idle',
  'projection-submit-admissible-busy',
  'projection-runtime-in-flight-busy',
  'projection-terminal-known',
  'projection-reconciliation-required-idle',
  'projection-reconciliation-required-busy',
  'projection-reconciled-terminal',
  'projection-controller-closed-unavailable',
  'export-lifecycle-runtime-type-allowlist',
  'export-lifecycle-negative-root',
  'export-lifecycle-negative-deep',
  'export-lifecycle-negative-undeclared',
  'disclosure-status-error-closed-canaries',
  'disclosure-retained-record-prohibited-fields',
  'preflight-transport-api-preserved',
  'preflight-lifecycle-requires-submit-reconcile',
  'profile-lifecycle-root-equals-core-state-dir-rejected',
  'profile-lifecycle-root-ancestor-of-core-state-dir-rejected',
  'profile-core-state-dir-ancestor-of-lifecycle-root-rejected',
  'profile-mountinfo-unique-deepest-selected',
  'profile-lifecycle-root-lone-surrogate-rejected',
  'profile-core-state-dir-lone-surrogate-rejected',
  'identity-config-canonical-vector',
  'identity-core-state-path-key-vector',
  'identity-root-path-digest-vector',
  'init-rename-error-prior-or-absent',
  'init-rename-error-complete-target',
  'submit-fence-rename-error-prior-submit-admissible',
  'submit-fence-rename-error-target-in-flight',
  'submit-known-result-rename-error-prior-in-flight',
  'submit-known-result-rename-error-target-known',
  'reconcile-rename-error-prior-reconciliation-required',
  'reconcile-rename-error-target-reconciled',
  'publication-rename-error-ambiguous-image-fail-closed',
  'submit-known-result-dir-sync-prior-visible',
  'submit-known-result-dir-sync-target-visible',
  'reconcile-dir-sync-prior-visible',
  'reconcile-dir-sync-target-visible',
].sort();

test('DSH lifecycle schemas and exact case corpus are closed and complete', () => {
  const rootMarkerValidate = validator('dsh/lifecycle/v1/root-marker.schema.json');
  const eventValidate = validator('dsh/lifecycle/v1/event-record.schema.json');
  const casesValidate = validator('dsh/lifecycle/v1/cases.schema.json');
  const cases = JSON.parse(
    readFileSync(join(root, 'spec/dsh/lifecycle/v1/fixtures/cases.json'), 'utf8'),
  );

  assert.ok(casesValidate(cases), ajv.errorsText(casesValidate.errors));
  const actualIds = cases.map(({ id }) => id);
  assert.equal(new Set(actualIds).size, 134, 'lifecycle case IDs must be unique');
  assert.deepEqual([...actualIds].sort(), dshLifecycleCaseIds);

  const rootMarker = {
    schemaVersion: 1,
    profile: 'dsh-lifecycle-linux-x86_64-gnu-ext4-local-v1',
    lifecycleRootId: 'root:example-01',
    rootPathDigest: 'a'.repeat(64),
    eventRecordSchemaVersion: 1,
  };
  assert.ok(rootMarkerValidate(rootMarker), ajv.errorsText(rootMarkerValidate.errors));
  assert.equal(rootMarkerValidate({ ...rootMarker, extra: true }), false);

  const request = JSON.parse(
    readFileSync(
      join(root, 'spec/protocol/v1/examples/workflow-signal-submit.request.json'),
      'utf8',
    ),
  );
  const ready = {
    schemaVersion: 1,
    lifecycleRootId: 'root:example-01',
    eventId: 'evt:example-01',
    configIdentity: 'b'.repeat(64),
    coreStatePathKey: 'c'.repeat(64),
    state: 'ready',
    attemptSequence: 0,
  };
  assert.ok(eventValidate(ready), ajv.errorsText(eventValidate.errors));
  assert.equal(eventValidate({ ...ready, attemptSequence: 1 }), false);
  assert.equal(eventValidate({ ...ready, state: 'unknown-state' }), false);
  assert.equal(
    eventValidate({
      ...ready,
      state: 'in_flight',
      attemptSequence: 1,
      requestId: 'req:example-01',
      payload: request.payload,
      trustedValueMappingKey: 'd'.repeat(64),
    }),
    true,
  );
  assert.equal(eventValidate({ ...ready, state: 'in_flight', attemptSequence: 1 }), false);
  assert.equal(
    eventValidate({
      ...ready,
      state: 'in_flight',
      attemptSequence: 9007199254740992,
      requestId: 'req:example-01',
      payload: request.payload,
      trustedValueMappingKey: 'd'.repeat(64),
    }),
    false,
  );
});

const dshLifecycleRuntimeCategoryById = Object.freeze({
  'init-first-root-ready': 'success',
  'init-first-root-nonempty': 'fail_closed',
  'init-first-root-partial-discard-only': 'fail_closed',
  'init-first-marker-file-sync-failure': 'fail_closed',
  'init-first-root-dir-sync-failure': 'fail_closed',
  'init-first-events-dir-sync-failure': 'fail_closed',
  'init-event-file-sync-failure': 'fail_closed',
  'init-event-rename-failure': 'fail_closed',
  'init-event-events-dir-sync-failure': 'fail_closed',
  'init-later-event-ready': 'success',
  'init-later-event-preserves-existing': 'success',
  'init-existing-event-rejected': 'fail_closed',
  'init-root-marker-mismatch': 'fail_closed',
  'init-unexpected-artifact': 'fail_closed',
  'init-missing-state-before-preflight': 'fail_closed',
  'init-malformed-state-before-preflight': 'fail_closed',
  'init-binding-mismatch-before-preflight': 'fail_closed',
  'init-trusted-bundle-mismatch-before-preflight': 'fail_closed',
  'init-core-state-path-key-mismatch-before-preflight': 'fail_closed',
  'init-core-state-valid-replacement-trusted-limitation': 'trusted_limitation',
  'profile-supported': 'success',
  'profile-realpath-statfs-only-rejected': 'fail_closed',
  'profile-root-core-mount-mismatch': 'fail_closed',
  'profile-symlink-component-rejected': 'fail_closed',
  'profile-bind-subtree-rejected': 'fail_closed',
  'profile-root-replacement-rejected': 'fail_closed',
  'profile-lexical-alias-rejected': 'fail_closed',
  'profile-different-root-restart-reset-rejected': 'fail_closed',
  'profile-mountinfo-missing-rejected': 'fail_closed',
  'profile-mountinfo-ambiguous-rejected': 'fail_closed',
  'profile-mountinfo-malformed-escape-rejected': 'fail_closed',
  'profile-readonly-rejected': 'fail_closed',
  'profile-non-ext4-rejected': 'fail_closed',
  'profile-device-disagreement-rejected': 'fail_closed',
  'profile-descriptor-identity-revalidation': 'success',
  'profile-unsupported-platform': 'fail_closed',
  'lease-duplicate-context-rejected': 'unavailable',
  'lease-duplicate-opened-identity-rejected': 'unavailable',
  'lease-dispose-reapply-stale-handles': 'unavailable',
  'lease-tool-disposer-failure-stale-tool': 'unavailable',
  'submit-ready-accepted': 'accepted',
  'submit-ready-duplicate': 'duplicate',
  'submit-ready-known-rejected': 'rejected',
  'submit-known-rejected-next-sequence': 'rejected',
  'submit-max-sequence-rejected': 'unavailable',
  'submit-retained-pair-byte-identical': 'accepted',
  'submit-fence-before-spawn': 'success',
  'submit-concurrent-n-single-child': 'busy',
  'submit-reconcile-race-single-child': 'busy',
  'submit-fence-file-create-failure': 'unavailable',
  'submit-fence-file-write-failure': 'unavailable',
  'submit-fence-file-sync-failure': 'unavailable',
  'submit-fence-rename-failure': 'unavailable',
  'submit-fence-events-dir-sync-failure': 'unavailable',
  'submit-crash-after-fence-before-spawn': 'outcome_unknown',
  'submit-crash-during-child': 'outcome_unknown',
  'submit-crash-after-core-append': 'outcome_unknown',
  'submit-crash-after-response-before-lifecycle': 'outcome_unknown',
  'submit-no-response-needs-reconciliation': 'outcome_unknown',
  'submit-undecodable-response-needs-reconciliation': 'outcome_unknown',
  'submit-oversized-response-needs-reconciliation': 'outcome_unknown',
  'submit-correlation-mismatch-needs-reconciliation': 'outcome_unknown',
  'submit-timeout-needs-reconciliation': 'outcome_unknown',
  'submit-spawn-failed-needs-reconciliation': 'outcome_unknown',
  'submit-reported-unknown-needs-reconciliation': 'outcome_unknown',
  'submit-aborted-needs-reconciliation': 'outcome_unknown',
  'submit-known-result-publication-failure': 'outcome_unknown',
  'submit-same-arguments-after-unknown-zero-child': 'outcome_unknown',
  'submit-changed-arguments-after-unknown-zero-child': 'outcome_unknown',
  'submit-lost-ack-real-binary-reconciled': 'accepted',
  'submit-retained-payload-recompute-mutant': 'accepted',
  'submit-lifecycle-loss-no-inmemory-ready-mutant': 'fail_closed',
  'restart-ready': 'success',
  'restart-in-flight-to-needs-reconciliation': 'outcome_unknown',
  'restart-known-accepted': 'success',
  'restart-known-duplicate': 'duplicate',
  'restart-known-rejected': 'success',
  'restart-needs-reconciliation': 'outcome_unknown',
  'restart-reconciled-accepted': 'accepted',
  'restart-reconciled-conflict': 'terminal',
  'restart-reconciled-absent': 'terminal',
  'restart-still-unknown': 'outcome_unknown',
  'restart-missing-malformed-unsafe-fail-closed': 'fail_closed',
  'reconcile-accepted': 'accepted',
  'reconcile-conflict': 'conflict',
  'reconcile-absent-no-submit': 'absent',
  'reconcile-unknown-still-unknown': 'outcome_unknown',
  'reconcile-concurrent-n-single-child': 'busy',
  'reconcile-publication-file-write-failure': 'unavailable',
  'reconcile-publication-file-sync-failure': 'unavailable',
  'reconcile-publication-rename-failure': 'unavailable',
  'reconcile-publication-events-dir-sync-failure': 'unavailable',
  'reconcile-journal-byte-identical': 'accepted',
  'reconcile-never-calls-submit-mutant': 'absent',
  'reconcile-absent-never-republishes-tool-mutant': 'absent',
  'projection-ready-idle': 'success',
  'projection-known-rejected-idle': 'success',
  'projection-submit-admissible-busy': 'busy',
  'projection-runtime-in-flight-busy': 'busy',
  'projection-terminal-known': 'terminal',
  'projection-reconciliation-required-idle': 'reconciliation_required',
  'projection-reconciliation-required-busy': 'busy',
  'projection-reconciled-terminal': 'terminal',
  'projection-controller-closed-unavailable': 'unavailable',
  'export-lifecycle-runtime-type-allowlist': 'contract_only',
  'export-lifecycle-negative-root': 'contract_only',
  'export-lifecycle-negative-deep': 'contract_only',
  'export-lifecycle-negative-undeclared': 'contract_only',
  'disclosure-status-error-closed-canaries': 'contract_only',
  'disclosure-retained-record-prohibited-fields': 'contract_only',
  'preflight-transport-api-preserved': 'contract_only',
  'preflight-lifecycle-requires-submit-reconcile': 'contract_only',
  'profile-lifecycle-root-equals-core-state-dir-rejected': 'fail_closed',
  'profile-lifecycle-root-ancestor-of-core-state-dir-rejected': 'fail_closed',
  'profile-core-state-dir-ancestor-of-lifecycle-root-rejected': 'fail_closed',
  'profile-mountinfo-unique-deepest-selected': 'success',
  'profile-lifecycle-root-lone-surrogate-rejected': 'fail_closed',
  'profile-core-state-dir-lone-surrogate-rejected': 'fail_closed',
  'identity-config-canonical-vector': 'contract_only',
  'identity-core-state-path-key-vector': 'contract_only',
  'identity-root-path-digest-vector': 'contract_only',
  'init-rename-error-prior-or-absent': 'fail_closed',
  'init-rename-error-complete-target': 'fail_closed',
  'submit-fence-rename-error-prior-submit-admissible': 'unavailable',
  'submit-fence-rename-error-target-in-flight': 'unavailable',
  'submit-known-result-rename-error-prior-in-flight': 'outcome_unknown',
  'submit-known-result-rename-error-target-known': 'outcome_unknown',
  'reconcile-rename-error-prior-reconciliation-required': 'unavailable',
  'reconcile-rename-error-target-reconciled': 'unavailable',
  'publication-rename-error-ambiguous-image-fail-closed': 'fail_closed',
  'submit-known-result-dir-sync-prior-visible': 'outcome_unknown',
  'submit-known-result-dir-sync-target-visible': 'outcome_unknown',
  'reconcile-dir-sync-prior-visible': 'unavailable',
  'reconcile-dir-sync-target-visible': 'unavailable',
});

const dshLifecycleNonDefaultRestartEvidenceById = Object.freeze({
  'init-first-marker-file-sync-failure':
    '{"restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":[],"absenceKinds":["uninitialized_root"]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'init-first-root-dir-sync-failure':
    '{"restartExpectation":{"kind":"invalid_image","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'init-first-events-dir-sync-failure':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["ready"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'init-event-file-sync-failure':
    '{"restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":[],"absenceKinds":["uninitialized_root","target_event_absent"]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"first-root","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":[],"absenceKinds":["uninitialized_root"]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"later-event","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":[],"absenceKinds":["target_event_absent"]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'init-event-rename-failure':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":[],"absenceKinds":["target_event_absent"]},"target":{"permitted":true,"lifecycleStates":["ready"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'init-event-events-dir-sync-failure':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":[],"absenceKinds":["target_event_absent"]},"target":{"permitted":true,"lifecycleStates":["ready"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'submit-fence-file-create-failure':
    '{"restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["ready","known_rejected"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"ready","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["ready"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"known-rejected","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["known_rejected"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'submit-fence-file-write-failure':
    '{"restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["ready","known_rejected"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"ready","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["ready"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"known-rejected","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["known_rejected"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'submit-fence-file-sync-failure':
    '{"restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["ready","known_rejected"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"ready","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["ready"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"known-rejected","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["known_rejected"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'submit-fence-rename-failure':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["ready","known_rejected"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'submit-fence-events-dir-sync-failure':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["ready","known_rejected"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'submit-known-result-publication-failure':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_accepted","known_duplicate","known_rejected"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"create-accepted","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"create-duplicate","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"create-rejected","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"write-accepted","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"write-duplicate","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"write-rejected","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"temp-sync-accepted","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"temp-sync-duplicate","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"temp-sync-rejected","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"rename-attempt-accepted","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_accepted"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"rename-attempt-duplicate","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_duplicate"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"rename-attempt-rejected","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_rejected"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"directory-sync-accepted","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_accepted"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"directory-sync-duplicate","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_duplicate"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"directory-sync-rejected","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_rejected"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'reconcile-publication-file-write-failure':
    '{"restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["needs_reconciliation","still_unknown"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"needs-reconciliation","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["needs_reconciliation"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"still-unknown","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["still_unknown"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'reconcile-publication-file-sync-failure':
    '{"restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["needs_reconciliation","still_unknown"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"needs-reconciliation","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["needs_reconciliation"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"still-unknown","restartExpectation":{"kind":"deterministic","prior":{"permitted":true,"lifecycleStates":["still_unknown"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'reconcile-publication-rename-failure':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["needs_reconciliation","still_unknown"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["reconciled_accepted","reconciled_conflict","reconciled_absent","still_unknown"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'reconcile-publication-events-dir-sync-failure':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["needs_reconciliation","still_unknown"],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["reconciled_accepted","reconciled_conflict","reconciled_absent","still_unknown"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'init-rename-error-prior-or-absent':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":[],"absenceKinds":["uninitialized_root","target_event_absent"]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"first-root","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":[],"absenceKinds":["uninitialized_root"]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"later-event","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":[],"absenceKinds":["target_event_absent"]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'init-rename-error-complete-target':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["ready"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'submit-fence-rename-error-prior-submit-admissible':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["ready","known_rejected"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"ready","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["ready"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"known-rejected","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["known_rejected"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'submit-fence-rename-error-target-in-flight':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'submit-known-result-rename-error-prior-in-flight':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'submit-known-result-rename-error-target-known':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_accepted","known_duplicate","known_rejected"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"accepted","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_accepted"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"duplicate","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_duplicate"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"rejected","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_rejected"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'reconcile-rename-error-prior-reconciliation-required':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["needs_reconciliation","still_unknown"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"needs-reconciliation","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["needs_reconciliation"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"still-unknown","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["still_unknown"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'reconcile-rename-error-target-reconciled':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["reconciled_accepted","reconciled_conflict","reconciled_absent","still_unknown"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"accepted","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["reconciled_accepted"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"conflict","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["reconciled_conflict"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"absent","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["reconciled_absent"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"still-unknown","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["still_unknown"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'publication-rename-error-ambiguous-image-fail-closed':
    '{"restartExpectation":{"kind":"invalid_image","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"initialization","restartExpectation":{"kind":"invalid_image","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"submit-fence","restartExpectation":{"kind":"invalid_image","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"submit-known-result","restartExpectation":{"kind":"invalid_image","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"startup-recovery","restartExpectation":{"kind":"invalid_image","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"reconciliation","restartExpectation":{"kind":"invalid_image","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'submit-known-result-dir-sync-prior-visible':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["in_flight"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[]}',
  'submit-known-result-dir-sync-target-visible':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_accepted","known_duplicate","known_rejected"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"accepted","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_accepted"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"duplicate","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_duplicate"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"rejected","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["known_rejected"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'reconcile-dir-sync-prior-visible':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["needs_reconciliation","still_unknown"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"needs-reconciliation","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["needs_reconciliation"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"still-unknown","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":true,"lifecycleStates":["still_unknown"],"absenceKinds":[]},"target":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
  'reconcile-dir-sync-target-visible':
    '{"restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["reconciled_accepted","reconciled_conflict","reconciled_absent","still_unknown"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"},"parameterizedVariants":[{"name":"accepted","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["reconciled_accepted"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"conflict","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["reconciled_conflict"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"absent","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["reconciled_absent"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}},{"name":"still-unknown","restartExpectation":{"kind":"acknowledgement_uncertain","prior":{"permitted":false,"lifecycleStates":[],"absenceKinds":[]},"target":{"permitted":true,"lifecycleStates":["still_unknown"],"absenceKinds":[]},"invalidOrAmbiguousImage":"fail_closed"}}]}',
});

test('DSH lifecycle case categories preserve the closed projection and evidence rules', () => {
  const validate = validator('dsh/lifecycle/v1/cases.schema.json');
  const cases = JSON.parse(
    readFileSync(join(root, 'spec/dsh/lifecycle/v1/fixtures/cases.json'), 'utf8'),
  );
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const restartOverrideIds = new Set(Object.keys(dshLifecycleNonDefaultRestartEvidenceById));
  assert.equal(restartOverrideIds.size, 29, 'exact restart override count');
  const unchangedTupleFields = [
    'id',
    'stage',
    'trigger',
    'expectedPersistedState',
    'expectedRuntimeCategory',
    'mutationAllowed',
    'expectedSubmitChildren',
    'expectedReconcileChildren',
    'expectedProjectionCategory',
    'evidenceClass',
  ];
  const existingOverrideIds = new Set([
    'init-first-root-dir-sync-failure',
    'init-first-events-dir-sync-failure',
    'init-event-rename-failure',
    'init-event-events-dir-sync-failure',
    'submit-fence-rename-failure',
    'submit-fence-events-dir-sync-failure',
    'submit-known-result-publication-failure',
    'reconcile-publication-rename-failure',
    'reconcile-publication-events-dir-sync-failure',
    'init-first-marker-file-sync-failure',
    'init-event-file-sync-failure',
    'submit-fence-file-create-failure',
    'submit-fence-file-write-failure',
    'submit-fence-file-sync-failure',
    'reconcile-publication-file-write-failure',
    'reconcile-publication-file-sync-failure',
  ]);
  const unchangedExistingRows = cases
    .slice(0, 112)
    .filter(({ id }) => !existingOverrideIds.has(id))
    .map((entry) => Object.fromEntries(unchangedTupleFields.map((field) => [field, entry[field]])));
  assert.equal(unchangedExistingRows.length, 96, 'exact unchanged-row count');
  assert.equal(
    createHash('sha256').update(JSON.stringify(unchangedExistingRows)).digest('hex'),
    '79495a732f3eb118208fa45a1be156327e57ddc48fa133e5d2688edb63b3d79e',
    'exact unchanged-row checkpoint binding',
  );
  const runtimeCategories = [
    'success',
    'accepted',
    'duplicate',
    'conflict',
    'absent',
    'rejected',
    'busy',
    'unavailable',
    'outcome_unknown',
    'reconciliation_required',
    'not_required',
    'terminal',
    'fail_closed',
    'trusted_limitation',
    'contract_only',
  ];
  assert.deepEqual(
    Object.keys(dshLifecycleRuntimeCategoryById),
    cases.map(({ id }) => id),
    'runtime-category mirror must cover the exact ordered corpus',
  );
  for (const [index, entry] of cases.entries()) {
    assert.equal(
      entry.expectedRuntimeCategory,
      dshLifecycleRuntimeCategoryById[entry.id],
      `${entry.id}: runtime-category mirror`,
    );
    for (const alternative of runtimeCategories) {
      if (alternative === entry.expectedRuntimeCategory) continue;
      const mutant = cases.map((candidate, candidateIndex) =>
        candidateIndex === index
          ? { ...candidate, expectedRuntimeCategory: alternative }
          : candidate,
      );
      assert.equal(
        mutant.every(
          (candidate) =>
            candidate.expectedRuntimeCategory === dshLifecycleRuntimeCategoryById[candidate.id],
        ),
        false,
        `${entry.id}: runtime category ${alternative} must be rejected`,
      );
    }
  }
  const defaultRestartEvidence = JSON.stringify({
    restartExpectation: {
      kind: 'not_applicable',
      prior: { permitted: false, lifecycleStates: [], absenceKinds: [] },
      target: { permitted: false, lifecycleStates: [], absenceKinds: [] },
      invalidOrAmbiguousImage: 'not_applicable',
    },
    parameterizedVariants: [],
  });
  const restartKinds = [
    'not_applicable',
    'deterministic',
    'acknowledgement_uncertain',
    'invalid_image',
  ];
  for (const entry of cases) {
    const expectedRestartEvidence =
      dshLifecycleNonDefaultRestartEvidenceById[entry.id] ?? defaultRestartEvidence;
    const actualRestartEvidence = JSON.stringify({
      restartExpectation: entry.restartExpectation,
      parameterizedVariants: entry.parameterizedVariants,
    });
    assert.equal(actualRestartEvidence, expectedRestartEvidence, `${entry.id}: restart evidence`);
    for (const alternative of restartKinds) {
      if (alternative === entry.restartExpectation.kind) continue;
      const mutant = JSON.stringify({
        restartExpectation: { ...entry.restartExpectation, kind: alternative },
        parameterizedVariants: entry.parameterizedVariants,
      });
      assert.notEqual(mutant, expectedRestartEvidence, `${entry.id}: restart-kind mutation`);
    }
    if (entry.parameterizedVariants.length > 0) {
      const [first, ...rest] = entry.parameterizedVariants;
      const mutant = JSON.stringify({
        restartExpectation: entry.restartExpectation,
        parameterizedVariants: [{ ...first, name: `${first.name}-mutant` }, ...rest],
      });
      assert.notEqual(mutant, expectedRestartEvidence, `${entry.id}: variant-name mutation`);
    }
  }
  const mutationCaseIds = new Set([
    'init-first-root-dir-sync-failure',
    'init-first-events-dir-sync-failure',
    'init-event-events-dir-sync-failure',
    'profile-realpath-statfs-only-rejected',
    'submit-fence-before-spawn',
    'submit-concurrent-n-single-child',
    'submit-reconcile-race-single-child',
    'submit-fence-events-dir-sync-failure',
    'submit-retained-payload-recompute-mutant',
    'submit-lifecycle-loss-no-inmemory-ready-mutant',
    'restart-in-flight-to-needs-reconciliation',
    'reconcile-concurrent-n-single-child',
    'reconcile-publication-events-dir-sync-failure',
    'reconcile-never-calls-submit-mutant',
    'reconcile-absent-never-republishes-tool-mutant',
  ]);
  const allowedProjectionByState = {
    ready: new Set(['submit_available', 'controller_unavailable']),
    in_flight: new Set(['no_publication', 'submit_busy']),
    known_accepted: new Set(['terminal_unavailable']),
    known_duplicate: new Set(['terminal_unavailable']),
    known_rejected: new Set(['submit_available', 'controller_unavailable']),
    needs_reconciliation: new Set(['reconciliation_required', 'reconciliation_busy']),
    reconciled_accepted: new Set(['terminal_unavailable']),
    reconciled_conflict: new Set(['terminal_unavailable']),
    reconciled_absent: new Set(['terminal_unavailable']),
    still_unknown: new Set(['reconciliation_required', 'reconciliation_busy']),
  };

  for (const entry of cases) {
    const contractOnly =
      entry.stage === 'exports' || entry.stage === 'disclosure' || entry.stage === 'preflight';
    assert.equal(entry.evidenceClass, entry.stage, `${entry.id}: evidence owner`);
    assert.equal(entry.mutationAllowed, mutationCaseIds.has(entry.id), `${entry.id}: mutation`);
    if (entry.expectedPersistedState !== null) {
      assert.ok(
        allowedProjectionByState[entry.expectedPersistedState].has(
          entry.expectedProjectionCategory,
        ),
        `${entry.id}: state/projection combination`,
      );
    }
    if (contractOnly) {
      assert.equal(entry.expectedPersistedState, null, `${entry.id}: no persisted state`);
      assert.equal(entry.expectedSubmitChildren, null, `${entry.id}: submit child n/a`);
      assert.equal(entry.expectedReconcileChildren, null, `${entry.id}: reconcile child n/a`);
      assert.equal(
        entry.expectedProjectionCategory,
        'not_applicable',
        `${entry.id}: projection n/a`,
      );
    } else {
      assert.notEqual(entry.expectedSubmitChildren, null, `${entry.id}: submit child count`);
      assert.notEqual(entry.expectedReconcileChildren, null, `${entry.id}: reconcile child count`);
      if (entry.stage !== 'submit') assert.equal(entry.expectedSubmitChildren, 0, entry.id);
      if (entry.stage === 'reconciliation') {
        assert.equal(entry.expectedReconcileChildren, 1, entry.id);
      } else if (entry.id === 'submit-lost-ack-real-binary-reconciled') {
        assert.equal(entry.expectedReconcileChildren, 1, entry.id);
      } else {
        assert.equal(entry.expectedReconcileChildren, 0, entry.id);
      }
    }
  }
  for (const id of [
    'submit-no-response-needs-reconciliation',
    'submit-undecodable-response-needs-reconciliation',
    'submit-oversized-response-needs-reconciliation',
    'submit-correlation-mismatch-needs-reconciliation',
    'submit-timeout-needs-reconciliation',
    'submit-spawn-failed-needs-reconciliation',
    'submit-reported-unknown-needs-reconciliation',
    'submit-aborted-needs-reconciliation',
  ]) {
    assert.equal(byId.get(id).expectedPersistedState, 'needs_reconciliation', id);
    assert.equal(byId.get(id).expectedRuntimeCategory, 'outcome_unknown', id);
  }
  const restartStates = new Map([
    ['restart-ready', 'ready'],
    ['restart-in-flight-to-needs-reconciliation', 'needs_reconciliation'],
    ['restart-known-accepted', 'known_accepted'],
    ['restart-known-duplicate', 'known_duplicate'],
    ['restart-known-rejected', 'known_rejected'],
    ['restart-needs-reconciliation', 'needs_reconciliation'],
    ['restart-reconciled-accepted', 'reconciled_accepted'],
    ['restart-reconciled-conflict', 'reconciled_conflict'],
    ['restart-reconciled-absent', 'reconciled_absent'],
    ['restart-still-unknown', 'still_unknown'],
  ]);
  for (const [id, state] of restartStates) {
    assert.equal(byId.get(id).expectedPersistedState, state, id);
  }
  assert.equal(validate([{ ...cases[0], id: 'not-an-authorized-case' }, ...cases.slice(1)]), false);
  assert.equal(
    validate([{ ...cases[0], expectedPersistedState: 'not-a-lifecycle-state' }, ...cases.slice(1)]),
    false,
  );
  assert.equal(validate([{ ...cases[0] }, ...cases.slice(0, -1)]), false, 'duplicate ID');
  assert.equal(validate([{ ...cases[0], extra: true }, ...cases.slice(1)]), false);
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
      if (direction === 'request' || direction === 'response') {
        assert.deepEqual(
          Object.keys(expected).sort(),
          ['code', 'kind', 'requestId', 'responseStage', 'responseVersion', 'schema'].sort(),
          `invalid/${direction}/${name}: expectation keys`,
        );
      }
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
