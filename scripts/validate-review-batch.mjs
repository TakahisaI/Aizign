#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const schemaPath = fileURLToPath(
  new URL('../docs/development/review-packet.schema.json', import.meta.url),
);
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('canonical JSON permits safe integers only');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonical(value), 'utf8'));
}

function unique(values, where) {
  if (new Set(values).size !== values.length) fail(`${where} contains duplicates`);
}

function sorted(values, where) {
  if (JSON.stringify(values) !== JSON.stringify([...values].sort())) {
    fail(`${where} must be lexicographically sorted`);
  }
}

function requireNonBlank(value, where) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${where} must be a non-blank string`);
  }
}

function verifyRfc3339(value, where) {
  if (typeof value !== 'string' || !RFC3339_RE.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${where} must be a valid RFC 3339 timestamp`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function safeArtifactPath(root, artifactPath, where) {
  if (path.isAbsolute(artifactPath)) fail(`${where} must be repository-relative`);
  const lexicalRoot = path.resolve(root);
  const resolved = path.resolve(lexicalRoot, artifactPath);
  if (!isWithin(lexicalRoot, resolved)) {
    fail(`${where} resolves outside the repository root`);
  }
  if (!fs.existsSync(resolved)) fail(`${where} does not resolve to a file`);

  const realRoot = fs.realpathSync(lexicalRoot);
  const realResolved = fs.realpathSync(resolved);
  if (!isWithin(realRoot, realResolved)) {
    fail(`${where} resolves outside the repository root through a symlink`);
  }
  if (!fs.statSync(realResolved).isFile()) fail(`${where} does not resolve to a file`);
  return realResolved;
}

function verifyEnvelope(value, where, root) {
  const bytes =
    value.content !== null
      ? Buffer.from(value.content, 'utf8')
      : fs.readFileSync(safeArtifactPath(root, value.artifact_path, `${where}.artifact_path`));
  if (value.sha256 !== sha256Bytes(bytes)) fail(`${where}.sha256 mismatch`);
}

function verifySortedArrays(packet, where) {
  const checkpoint = packet.batch_context.checkpoint.checkpoint_content;
  sorted(packet.batch_context.target.changed_files, `${where}.target.changed_files`);
  for (const claim of checkpoint.claims) {
    sorted(claim.authority_ids, `${where}.${claim.claim_id}.authority_ids`);
  }
  for (const evidence of checkpoint.evidence_requirements) {
    sorted(evidence.subject_ids, `${where}.${evidence.evidence_id}.subject_ids`);
    sorted(evidence.evidence_ref_ids, `${where}.${evidence.evidence_id}.evidence_ref_ids`);
  }
  for (const assignment of checkpoint.review_assignments) {
    sorted(assignment.failure_models, `${where}.${assignment.perspective_id}.failure_models`);
    sorted(assignment.subject_ids, `${where}.${assignment.perspective_id}.subject_ids`);
    sorted(assignment.required_checks, `${where}.${assignment.perspective_id}.required_checks`);
    sorted(
      assignment.assignment_out_of_range,
      `${where}.${assignment.perspective_id}.assignment_out_of_range`,
    );
  }
  for (const coverage of packet.batch_context.coverage) {
    sorted(coverage.perspective_ids, `${where}.${coverage.subject_id}.perspective_ids`);
  }
}

function verifyReferences(packet, where) {
  const context = packet.batch_context;
  const checkpoint = context.checkpoint.checkpoint_content;

  unique(
    context.controlling_authorities.map((item) => item.authority_id),
    `${where}.controlling authority IDs`,
  );
  unique(
    checkpoint.normative_authorities.map((item) => item.authority_id),
    `${where}.checkpoint authority IDs`,
  );
  unique(
    checkpoint.canonical_owners.map((item) => item.owner_id),
    `${where}.owner IDs`,
  );
  unique(
    checkpoint.claims.map((item) => item.claim_id),
    `${where}.claim IDs`,
  );
  unique(
    checkpoint.ranges.map((item) => item.range_id),
    `${where}.range IDs`,
  );
  unique(
    checkpoint.evidence_requirements.map((item) => item.evidence_id),
    `${where}.evidence requirement IDs`,
  );
  unique(
    checkpoint.review_assignments.map((item) => item.perspective_id),
    `${where}.perspective IDs`,
  );
  unique(
    context.issue_pr_snapshots.map((item) => item.snapshot_id),
    `${where}.snapshot IDs`,
  );
  unique(
    context.external_constraints.map((item) => item.constraint_id),
    `${where}.external constraint IDs`,
  );
  unique(
    context.evidence.map((item) => item.evidence_id),
    `${where}.retained evidence IDs`,
  );

  if (canonical(context.known_evidence_gaps) !== canonical(checkpoint.known_evidence_gaps)) {
    fail(`${where}: batch and checkpoint evidence-gap registers must match exactly`);
  }

  const controllingById = new Map(
    context.controlling_authorities.map((item) => [item.authority_id, item]),
  );
  const authoritiesById = new Map(
    checkpoint.normative_authorities.map((item) => [item.authority_id, item]),
  );
  const ownerIds = new Set(checkpoint.canonical_owners.map((item) => item.owner_id));
  const claimIds = new Set(checkpoint.claims.map((item) => item.claim_id));
  const reviewableRangeIds = new Set(
    checkpoint.ranges
      .filter((item) => item.disposition !== 'out_of_range')
      .map((item) => item.range_id),
  );
  const evidenceRequirementIds = new Set(
    checkpoint.evidence_requirements.map((item) => item.evidence_id),
  );
  const gapIds = new Set(checkpoint.known_evidence_gaps.map((item) => item.gap_id));
  const retainedEvidenceIds = new Set(context.evidence.map((item) => item.evidence_id));
  const snapshotById = new Map(
    context.issue_pr_snapshots.map((item) => [item.snapshot_id, item]),
  );
  const constraintsById = new Map(
    context.external_constraints.map((item) => [item.constraint_id, item]),
  );
  const assignments = new Map(
    checkpoint.review_assignments.map((item) => [item.perspective_id, item]),
  );

  const subjectIds = [
    ...claimIds,
    ...reviewableRangeIds,
    ...evidenceRequirementIds,
    ...gapIds,
  ];
  unique(subjectIds, `${where}.stable subject IDs`);
  const requiredSubjectIds = new Set(subjectIds);

  for (const authority of checkpoint.normative_authorities) {
    const controlling = controllingById.get(authority.authority_id);
    if (!controlling || canonical(controlling) !== canonical(authority)) {
      fail(
        `${where}: checkpoint authority ${authority.authority_id} is not an exact ` +
          'controlling authority',
      );
    }
  }
  for (const claim of checkpoint.claims) {
    for (const authorityId of claim.authority_ids) {
      if (!authoritiesById.has(authorityId)) {
        fail(`${where}: ${claim.claim_id} references unknown authority ${authorityId}`);
      }
    }
  }
  for (const duplicate of checkpoint.duplicate_owners_to_remove) {
    if (!ownerIds.has(duplicate.canonical_owner_id)) {
      fail(`${where}: duplicate owner references unknown owner ${duplicate.canonical_owner_id}`);
    }
  }

  const subjectsWithEvidence = new Set();
  for (const evidence of checkpoint.evidence_requirements) {
    for (const subjectId of evidence.subject_ids) {
      if (!claimIds.has(subjectId) && !reviewableRangeIds.has(subjectId)) {
        fail(`${where}: ${evidence.evidence_id} references non-reviewable subject ${subjectId}`);
      }
      subjectsWithEvidence.add(subjectId);
    }
    for (const evidenceRefId of evidence.evidence_ref_ids) {
      if (!retainedEvidenceIds.has(evidenceRefId)) {
        fail(`${where}: ${evidence.evidence_id} references unknown evidence ${evidenceRefId}`);
      }
    }
  }
  for (const claimId of claimIds) {
    if (!subjectsWithEvidence.has(claimId)) {
      fail(`${where}: claim ${claimId} has no evidence requirement`);
    }
  }
  for (const rangeId of reviewableRangeIds) {
    if (!subjectsWithEvidence.has(rangeId)) {
      fail(`${where}: range ${rangeId} has no evidence requirement`);
    }
  }

  const contractSnapshot = snapshotById.get(checkpoint.contract_snapshot_id);
  if (!contractSnapshot) {
    fail(`${where}: contract snapshot ${checkpoint.contract_snapshot_id} does not exist`);
  }

  const adapterConstraint = constraintsById.get(
    context.execution_adapter.instruction_constraint_id,
  );
  if (!adapterConstraint) {
    fail(
      `${where}: execution adapter references unknown instruction constraint ` +
        context.execution_adapter.instruction_constraint_id,
    );
  }
  if (
    context.execution_adapter.mode === 'skill' &&
    context.execution_adapter.skill_sha256 !== adapterConstraint.sha256
  ) {
    fail(`${where}: skill digest does not match its frozen instruction constraint`);
  }

  for (const assignment of assignments.values()) {
    for (const subjectId of assignment.subject_ids) {
      if (!requiredSubjectIds.has(subjectId)) {
        fail(
          `${where}: ${assignment.perspective_id} references unknown or out-of-range ` +
            `subject ${subjectId}`,
        );
      }
    }
  }

  const expectedAssignment = assignments.get(packet.assignment.perspective_id);
  if (!expectedAssignment || canonical(expectedAssignment) !== canonical(packet.assignment)) {
    fail(`${where}: packet assignment does not match checkpoint assignment`);
  }

  const coverage = new Map();
  for (const entry of context.coverage) {
    if (!requiredSubjectIds.has(entry.subject_id)) {
      fail(`${where}: coverage references unknown or out-of-range subject ${entry.subject_id}`);
    }
    for (const perspectiveId of entry.perspective_ids) {
      if (!assignments.has(perspectiveId)) {
        fail(`${where}: coverage references unknown perspective ${perspectiveId}`);
      }
    }
    if (coverage.has(entry.subject_id)) fail(`${where}: duplicate coverage subject`);
    coverage.set(entry.subject_id, new Set(entry.perspective_ids));
  }

  for (const subjectId of requiredSubjectIds) {
    if (!coverage.has(subjectId)) fail(`${where}: missing coverage for ${subjectId}`);
  }

  const derived = new Map();
  for (const assignment of assignments.values()) {
    for (const subjectId of assignment.subject_ids) {
      if (!derived.has(subjectId)) derived.set(subjectId, new Set());
      derived.get(subjectId).add(assignment.perspective_id);
    }
  }
  if (coverage.size !== derived.size) {
    fail(`${where}: coverage and assignment subjects differ`);
  }
  for (const [subjectId, perspectiveIds] of coverage) {
    const expected = [...(derived.get(subjectId) ?? [])].sort();
    if (JSON.stringify([...perspectiveIds].sort()) !== JSON.stringify(expected)) {
      fail(`${where}: coverage does not match assignments for ${subjectId}`);
    }
  }

  return new Set(assignments.keys());
}

function verifyPacket(packet, filePath, root) {
  const where = path.basename(filePath);
  if (!validateSchema(packet)) {
    fail(`${where}: schema validation failed: ${JSON.stringify(validateSchema.errors)}`);
  }

  verifySortedArrays(packet, where);
  const context = packet.batch_context;
  const target = context.target;
  verifyRfc3339(context.created_at, `${where}.batch_context.created_at`);

  if (target.pull_request_number !== null && target.sha !== target.pull_request_head_sha) {
    fail(`${where}: target SHA differs from pull-request head SHA`);
  }
  if (target.pull_request_number === null && target.pull_request_head_sha !== null) {
    fail(`${where}: non-PR target has a pull-request head SHA`);
  }

  if (context.workflow.mode === 'bootstrap') {
    if (context.workflow.procedure_path !== null || context.workflow.review_packet_path !== null) {
      fail(`${where}: bootstrap mode cannot use candidate workflow paths`);
    }
    if (context.workflow.revision !== target.base_sha) {
      fail(`${where}: bootstrap workflow revision must equal base SHA`);
    }
    for (const authority of context.controlling_authorities) {
      if (authority.revision !== target.base_sha) {
        fail(`${where}: bootstrap controlling authorities must use the base SHA`);
      }
    }
    if (context.execution_adapter.mode !== 'manual') {
      fail(`${where}: bootstrap batches must use the frozen manual execution adapter`);
    }
  } else if (
    context.workflow.procedure_path === null ||
    context.workflow.review_packet_path === null
  ) {
    fail(`${where}: merged workflow mode requires both workflow paths`);
  }

  if (target.pull_request_number !== null) {
    const matchingPrSnapshots = context.issue_pr_snapshots.filter(
      (item) => item.kind === 'pull_request' && item.number === target.pull_request_number,
    );
    if (matchingPrSnapshots.length !== 1) {
      fail(`${where}: PR targets require exactly one matching pull-request snapshot`);
    }
  }

  if (context.checkpoint.checkpoint_content.workflow_revision !== context.workflow.revision) {
    fail(`${where}: checkpoint workflow revision differs from the batch workflow revision`);
  }

  const checkpoint = context.checkpoint;
  const checkpointDigest = sha256Canonical(checkpoint.checkpoint_content);
  if (checkpoint.checkpoint_sha256 !== checkpointDigest) {
    fail(`${where}: checkpoint digest mismatch`);
  }
  const approval = checkpoint.approval;
  if (approval.decision === 'approved') {
    if (approval.approved_checkpoint_sha256 !== checkpointDigest) {
      fail(`${where}: approved checkpoint digest mismatch`);
    }
    requireNonBlank(approval.maintainer_identity, `${where}.approval.maintainer_identity`);
    requireNonBlank(approval.approval_reference, `${where}.approval.approval_reference`);
    verifyRfc3339(approval.approved_at, `${where}.approval.approved_at`);
  } else if (approval.decision === 'awaiting') {
    if (
      approval.approved_checkpoint_sha256 !== null ||
      approval.maintainer_identity !== null ||
      approval.approved_at !== null ||
      approval.approval_reference !== null
    ) {
      fail(`${where}: awaiting approval envelope must contain null metadata`);
    }
  } else {
    if (approval.approved_checkpoint_sha256 !== null) {
      fail(`${where}: rejected approval envelope must not contain an approved digest`);
    }
    requireNonBlank(approval.maintainer_identity, `${where}.approval.maintainer_identity`);
    requireNonBlank(approval.approval_reference, `${where}.approval.approval_reference`);
    verifyRfc3339(approval.approved_at, `${where}.approval.approved_at`);
  }

  for (const snapshot of context.issue_pr_snapshots) {
    verifyRfc3339(snapshot.captured_at, `${where}.${snapshot.snapshot_id}.captured_at`);
    verifyEnvelope(snapshot, `${where}.${snapshot.snapshot_id}`, root);
  }
  for (const constraint of context.external_constraints) {
    verifyRfc3339(constraint.captured_at, `${where}.${constraint.constraint_id}.captured_at`);
    verifyEnvelope(constraint, `${where}.${constraint.constraint_id}`, root);
  }
  for (const evidence of context.evidence) {
    if (evidence.kind === 'artifact') {
      verifyRfc3339(evidence.captured_at, `${where}.${evidence.evidence_id}.captured_at`);
      verifyEnvelope(evidence, `${where}.${evidence.evidence_id}`, root);
    }
  }

  const expectedPerspectives = verifyReferences(packet, where);
  const contextDigest = sha256Canonical(context);
  if (packet.batch_context_sha256 !== contextDigest) {
    fail(`${where}: batch-context digest mismatch`);
  }
  const packetForDigest = structuredClone(packet);
  delete packetForDigest.packet_sha256;
  if (packet.packet_sha256 !== sha256Canonical(packetForDigest)) {
    fail(`${where}: packet digest mismatch`);
  }

  return {
    packet,
    canonicalContext: canonical(context),
    expectedPerspectives,
  };
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    fail('usage: node scripts/validate-review-batch.mjs <packet-1.json> ...');
  }
  const root = process.cwd();
  const validated = files.map((file) => {
    const resolved = path.resolve(file);
    return verifyPacket(JSON.parse(fs.readFileSync(resolved, 'utf8')), resolved, root);
  });

  const first = validated[0];
  for (const item of validated.slice(1)) {
    if (
      item.packet.batch_id !== first.packet.batch_id ||
      item.packet.batch_context_sha256 !== first.packet.batch_context_sha256 ||
      item.canonicalContext !== first.canonicalContext
    ) {
      fail('all packet files must contain the same batch ID and canonical batch context');
    }
  }

  unique(validated.map((item) => item.packet.packet_id), 'packet IDs');
  unique(
    validated.map((item) => item.packet.assignment.perspective_id),
    'perspective packet IDs',
  );
  const actual = new Set(validated.map((item) => item.packet.assignment.perspective_id));
  if (
    JSON.stringify([...actual].sort()) !==
    JSON.stringify([...first.expectedPerspectives].sort())
  ) {
    fail('the packet set does not contain exactly one packet for every perspective');
  }

  console.log(`validated ${validated.length} packet(s) for batch ${first.packet.batch_id}`);
  console.log(`batch_context_sha256=${first.packet.batch_context_sha256}`);
}

try {
  main();
} catch (error) {
  console.error(`review batch validation failed: ${error.message}`);
  process.exitCode = 1;
}
