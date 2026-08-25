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

function safeArtifactPath(root, artifactPath, where) {
  if (path.isAbsolute(artifactPath)) fail(`${where} must be repository-relative`);
  const resolved = path.resolve(root, artifactPath);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) fail(`${where} resolves outside the repository root`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail(`${where} does not resolve to a file`);
  }
  return resolved;
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
  unique(
    context.known_evidence_gaps.map((item) => item.gap_id),
    `${where}.batch gap IDs`,
  );
  unique(
    checkpoint.known_evidence_gaps.map((item) => item.gap_id),
    `${where}.checkpoint gap IDs`,
  );

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
  const evidenceIds = new Set(
    checkpoint.evidence_requirements.map((item) => item.evidence_id),
  );
  const requiredSubjectIds = new Set([...claimIds, ...reviewableRangeIds, ...evidenceIds]);
  const assignments = new Map(
    checkpoint.review_assignments.map((item) => [item.perspective_id, item]),
  );

  for (const authority of checkpoint.normative_authorities) {
    const controlling = controllingById.get(authority.authority_id);
    if (!controlling || canonical(controlling) !== canonical(authority)) {
      fail(
        `${where}: checkpoint authority ${authority.authority_id} is not an exact controlling authority`,
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
  for (const evidence of checkpoint.evidence_requirements) {
    for (const subjectId of evidence.subject_ids) {
      if (!claimIds.has(subjectId) && !reviewableRangeIds.has(subjectId)) {
        fail(`${where}: ${evidence.evidence_id} references non-reviewable subject ${subjectId}`);
      }
    }
  }
  for (const assignment of assignments.values()) {
    for (const subjectId of assignment.subject_ids) {
      if (!requiredSubjectIds.has(subjectId)) {
        fail(
          `${where}: ${assignment.perspective_id} references unknown or out-of-range subject ${subjectId}`,
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
  } else if (
    context.workflow.procedure_path === null ||
    context.workflow.review_packet_path === null
  ) {
    fail(`${where}: merged workflow mode requires both workflow paths`);
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
    if (
      approval.approved_checkpoint_sha256 !== checkpointDigest ||
      approval.maintainer_identity === null ||
      approval.approved_at === null ||
      approval.approval_reference === null
    ) {
      fail(`${where}: incomplete or mismatched approved checkpoint envelope`);
    }
  } else if (approval.approved_checkpoint_sha256 !== null) {
    fail(`${where}: non-approved envelope must not contain an approved digest`);
  }

  for (const snapshot of context.issue_pr_snapshots) {
    verifyEnvelope(snapshot, `${where}.${snapshot.snapshot_id}`, root);
  }
  for (const constraint of context.external_constraints) {
    verifyEnvelope(constraint, `${where}.${constraint.constraint_id}`, root);
  }
  for (const evidence of context.evidence) {
    if (evidence.kind === 'artifact') {
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
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...first.expectedPerspectives].sort())) {
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
