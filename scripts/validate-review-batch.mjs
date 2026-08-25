#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, where) {
  if (!isObject(value)) fail(`${where} must be an object`);
}

function assertArray(value, where, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  if (nonEmpty && value.length === 0) fail(`${where} must not be empty`);
}

function assertString(value, where, { nonEmpty = true } = {}) {
  if (typeof value !== "string") fail(`${where} must be a string`);
  if (nonEmpty && value.length === 0) fail(`${where} must not be empty`);
}

function assertNullableString(value, where) {
  if (value !== null && typeof value !== "string") {
    fail(`${where} must be a string or null`);
  }
}

function assertSafeInteger(value, where) {
  if (!Number.isSafeInteger(value)) fail(`${where} must be a safe integer`);
}

function assertEnum(value, allowed, where) {
  if (!allowed.includes(value)) {
    fail(`${where} must be one of: ${allowed.join(", ")}`);
  }
}

function assertId(value, where) {
  assertString(value, where);
  if (!ID_RE.test(value)) fail(`${where} has an invalid identifier shape`);
}

function assertSha1(value, where) {
  assertString(value, where);
  if (!SHA1_RE.test(value)) fail(`${where} must be a lowercase 40-hex SHA`);
}

function assertSha256(value, where) {
  assertString(value, where);
  if (!SHA256_RE.test(value)) fail(`${where} must use sha256:<64 lowercase hex>`);
}

function assertExactKeys(value, required, optional, where) {
  assertObject(value, where);
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  const unknown = actual.filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${where} has unknown fields: ${unknown.join(", ")}`);
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) fail(`${where} is missing fields: ${missing.join(", ")}`);
}

function assertUnique(values, where) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${where} contains duplicate value: ${value}`);
    seen.add(value);
  }
}

function assertSortedUniqueStrings(values, where, { nonEmpty = false } = {}) {
  assertArray(values, where, { nonEmpty });
  for (let i = 0; i < values.length; i += 1) {
    assertString(values[i], `${where}[${i}]`);
  }
  assertUnique(values, where);
  const sorted = [...values].sort();
  if (JSON.stringify(values) !== JSON.stringify(sorted)) {
    fail(`${where} must be lexicographically sorted`);
  }
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("canonical JSON permits safe integers only");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  fail(`unsupported JSON value: ${typeof value}`);
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonical(value), "utf8"));
}

function resolveArtifact(root, artifactPath, where) {
  assertString(artifactPath, where);
  if (path.isAbsolute(artifactPath)) fail(`${where} must be repository-relative`);
  const normalized = path.normalize(artifactPath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    fail(`${where} must not traverse outside the repository root`);
  }
  const resolved = path.resolve(root, normalized);
  const rootWithSep = `${path.resolve(root)}${path.sep}`;
  if (resolved !== path.resolve(root) && !resolved.startsWith(rootWithSep)) {
    fail(`${where} resolves outside the repository root`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail(`${where} does not resolve to a file: ${artifactPath}`);
  }
  return resolved;
}

function validateContentEnvelope(value, where, root) {
  assertExactKeys(
    value,
    ["source_reference", "captured_at", "content", "artifact_path", "sha256"],
    [],
    where,
  );
  assertString(value.source_reference, `${where}.source_reference`);
  assertString(value.captured_at, `${where}.captured_at`);
  assertNullableString(value.content, `${where}.content`);
  assertNullableString(value.artifact_path, `${where}.artifact_path`);
  assertSha256(value.sha256, `${where}.sha256`);

  const hasContent = value.content !== null;
  const hasArtifact = value.artifact_path !== null;
  if (hasContent === hasArtifact) {
    fail(`${where} must set exactly one of content or artifact_path`);
  }

  const bytes = hasContent
    ? Buffer.from(value.content, "utf8")
    : fs.readFileSync(resolveArtifact(root, value.artifact_path, `${where}.artifact_path`));
  const expected = sha256Bytes(bytes);
  if (value.sha256 !== expected) fail(`${where}.sha256 mismatch`);
}

function validateAuthority(value, where) {
  assertExactKeys(
    value,
    ["authority_id", "path", "revision", "section", "purpose"],
    [],
    where,
  );
  assertId(value.authority_id, `${where}.authority_id`);
  assertString(value.path, `${where}.path`);
  assertSha1(value.revision, `${where}.revision`);
  assertString(value.section, `${where}.section`);
  assertString(value.purpose, `${where}.purpose`);
}

function validateCanonicalOwner(value, where) {
  assertExactKeys(value, ["owner_id", "surface", "path"], [], where);
  assertId(value.owner_id, `${where}.owner_id`);
  assertString(value.surface, `${where}.surface`);
  assertString(value.path, `${where}.path`);
}

function validateDuplicateOwner(value, where) {
  assertExactKeys(value, ["path", "canonical_owner_id", "disposition"], [], where);
  assertString(value.path, `${where}.path`);
  assertId(value.canonical_owner_id, `${where}.canonical_owner_id`);
  assertEnum(
    value.disposition,
    ["delete", "migrate", "provisional", "retain-distinct"],
    `${where}.disposition`,
  );
}

function validateOldPath(value, where) {
  assertExactKeys(
    value,
    ["path", "disposition", "target_or_reason", "owner_or_trigger"],
    [],
    where,
  );
  assertString(value.path, `${where}.path`);
  assertEnum(
    value.disposition,
    ["deleted", "migrated", "provisional", "retained-distinct"],
    `${where}.disposition`,
  );
  assertString(value.target_or_reason, `${where}.target_or_reason`);
  assertString(value.owner_or_trigger, `${where}.owner_or_trigger`);
}

function validateClaim(value, where) {
  assertExactKeys(value, ["claim_id", "statement", "authority_ids", "falsification"], [], where);
  assertId(value.claim_id, `${where}.claim_id`);
  assertString(value.statement, `${where}.statement`);
  assertSortedUniqueStrings(value.authority_ids, `${where}.authority_ids`, { nonEmpty: true });
  assertString(value.falsification, `${where}.falsification`);
}

function validateRange(value, where) {
  assertExactKeys(
    value,
    ["range_id", "kind", "value", "disposition", "reason", "owner_or_follow_up"],
    [],
    where,
  );
  assertId(value.range_id, `${where}.range_id`);
  assertEnum(value.kind, ["commitment", "lifecycle", "consumer"], `${where}.kind`);
  assertString(value.value, `${where}.value`);
  assertEnum(
    value.disposition,
    ["included", "out_of_range", "evidence_gap"],
    `${where}.disposition`,
  );
  assertString(value.reason, `${where}.reason`);
  assertString(value.owner_or_follow_up, `${where}.owner_or_follow_up`);
}

function validateEvidenceRequirement(value, where) {
  assertExactKeys(
    value,
    ["evidence_id", "subject_ids", "method", "expected_detection", "owner"],
    [],
    where,
  );
  assertId(value.evidence_id, `${where}.evidence_id`);
  assertSortedUniqueStrings(value.subject_ids, `${where}.subject_ids`, { nonEmpty: true });
  assertString(value.method, `${where}.method`);
  assertString(value.expected_detection, `${where}.expected_detection`);
  assertString(value.owner, `${where}.owner`);
}

function validateReviewAssignment(value, where) {
  assertExactKeys(
    value,
    [
      "perspective_id",
      "title",
      "question",
      "failure_models",
      "subject_ids",
      "required_checks",
      "assignment_out_of_range",
    ],
    [],
    where,
  );
  assertId(value.perspective_id, `${where}.perspective_id`);
  assertString(value.title, `${where}.title`);
  assertString(value.question, `${where}.question`);
  assertSortedUniqueStrings(value.failure_models, `${where}.failure_models`, { nonEmpty: true });
  assertSortedUniqueStrings(value.subject_ids, `${where}.subject_ids`, { nonEmpty: true });
  assertSortedUniqueStrings(value.required_checks, `${where}.required_checks`, { nonEmpty: true });
  assertSortedUniqueStrings(value.assignment_out_of_range, `${where}.assignment_out_of_range`);
}

function validateGap(value, where) {
  assertExactKeys(value, ["gap_id", "description", "owner_or_follow_up"], [], where);
  assertId(value.gap_id, `${where}.gap_id`);
  assertString(value.description, `${where}.description`);
  assertString(value.owner_or_follow_up, `${where}.owner_or_follow_up`);
}

function validateCheckpointContent(value, where) {
  assertExactKeys(
    value,
    [
      "schema",
      "checkpoint_id",
      "workflow_revision",
      "change_class",
      "contract_revision",
      "normative_authorities",
      "canonical_owners",
      "duplicate_owners_to_remove",
      "old_path_dispositions",
      "claims",
      "ranges",
      "evidence_requirements",
      "review_assignments",
      "implementation_scope",
      "known_evidence_gaps",
    ],
    [],
    where,
  );
  if (value.schema !== "aizign.checkpoint/v1") {
    fail(`${where}.schema must be aizign.checkpoint/v1`);
  }
  assertId(value.checkpoint_id, `${where}.checkpoint_id`);
  assertSha1(value.workflow_revision, `${where}.workflow_revision`);
  assertEnum(value.change_class, ["Boundary change", "Milestone review"], `${where}.change_class`);
  assertString(value.contract_revision, `${where}.contract_revision`);

  assertArray(value.normative_authorities, `${where}.normative_authorities`, { nonEmpty: true });
  value.normative_authorities.forEach((item, index) =>
    validateAuthority(item, `${where}.normative_authorities[${index}]`),
  );
  assertUnique(
    value.normative_authorities.map((item) => item.authority_id),
    `${where}.normative_authorities authority IDs`,
  );

  assertArray(value.canonical_owners, `${where}.canonical_owners`, { nonEmpty: true });
  value.canonical_owners.forEach((item, index) =>
    validateCanonicalOwner(item, `${where}.canonical_owners[${index}]`),
  );
  assertUnique(
    value.canonical_owners.map((item) => item.owner_id),
    `${where}.canonical_owners owner IDs`,
  );

  assertArray(value.duplicate_owners_to_remove, `${where}.duplicate_owners_to_remove`);
  value.duplicate_owners_to_remove.forEach((item, index) =>
    validateDuplicateOwner(item, `${where}.duplicate_owners_to_remove[${index}]`),
  );

  assertArray(value.old_path_dispositions, `${where}.old_path_dispositions`);
  value.old_path_dispositions.forEach((item, index) =>
    validateOldPath(item, `${where}.old_path_dispositions[${index}]`),
  );

  assertArray(value.claims, `${where}.claims`, { nonEmpty: true });
  value.claims.forEach((item, index) => validateClaim(item, `${where}.claims[${index}]`));
  assertUnique(value.claims.map((item) => item.claim_id), `${where}.claims claim IDs`);

  assertArray(value.ranges, `${where}.ranges`, { nonEmpty: true });
  value.ranges.forEach((item, index) => validateRange(item, `${where}.ranges[${index}]`));
  assertUnique(value.ranges.map((item) => item.range_id), `${where}.ranges range IDs`);

  assertArray(value.evidence_requirements, `${where}.evidence_requirements`, { nonEmpty: true });
  value.evidence_requirements.forEach((item, index) =>
    validateEvidenceRequirement(item, `${where}.evidence_requirements[${index}]`),
  );
  assertUnique(
    value.evidence_requirements.map((item) => item.evidence_id),
    `${where}.evidence_requirements evidence IDs`,
  );

  assertArray(value.review_assignments, `${where}.review_assignments`, { nonEmpty: true });
  value.review_assignments.forEach((item, index) =>
    validateReviewAssignment(item, `${where}.review_assignments[${index}]`),
  );
  assertUnique(
    value.review_assignments.map((item) => item.perspective_id),
    `${where}.review_assignments perspective IDs`,
  );

  assertEnum(
    value.implementation_scope,
    ["ADR/specification", "implementation", "review-only"],
    `${where}.implementation_scope`,
  );

  assertArray(value.known_evidence_gaps, `${where}.known_evidence_gaps`);
  value.known_evidence_gaps.forEach((item, index) =>
    validateGap(item, `${where}.known_evidence_gaps[${index}]`),
  );
  assertUnique(
    value.known_evidence_gaps.map((item) => item.gap_id),
    `${where}.known_evidence_gaps gap IDs`,
  );

  const authorityIds = new Set(value.normative_authorities.map((item) => item.authority_id));
  const ownerIds = new Set(value.canonical_owners.map((item) => item.owner_id));
  const claimIds = new Set(value.claims.map((item) => item.claim_id));
  const rangeIds = new Set(value.ranges.map((item) => item.range_id));
  const evidenceIds = new Set(value.evidence_requirements.map((item) => item.evidence_id));
  const subjectIds = new Set([...claimIds, ...rangeIds, ...evidenceIds]);

  for (const item of value.claims) {
    for (const authorityId of item.authority_ids) {
      if (!authorityIds.has(authorityId)) {
        fail(`${where}.claims ${item.claim_id} references unknown authority ${authorityId}`);
      }
    }
  }
  for (const item of value.duplicate_owners_to_remove) {
    if (!ownerIds.has(item.canonical_owner_id)) {
      fail(
        `${where}.duplicate_owners_to_remove references unknown owner ${item.canonical_owner_id}`,
      );
    }
  }
  for (const item of value.evidence_requirements) {
    for (const subjectId of item.subject_ids) {
      if (!claimIds.has(subjectId) && !rangeIds.has(subjectId)) {
        fail(
          `${where}.evidence_requirements ${item.evidence_id} references non-claim/range subject ${subjectId}`,
        );
      }
    }
  }
  for (const item of value.review_assignments) {
    for (const subjectId of item.subject_ids) {
      if (!subjectIds.has(subjectId)) {
        fail(
          `${where}.review_assignments ${item.perspective_id} references unknown subject ${subjectId}`,
        );
      }
    }
  }

  return {
    subjectIds,
    requiredSubjectIds: new Set([
      ...claimIds,
      ...value.ranges
        .filter((item) => item.disposition !== "out_of_range")
        .map((item) => item.range_id),
      ...evidenceIds,
    ]),
    assignmentsByPerspective: new Map(
      value.review_assignments.map((item) => [item.perspective_id, item]),
    ),
  };
}

function validateApproval(value, checkpointSha, where) {
  assertExactKeys(
    value,
    [
      "decision",
      "approved_checkpoint_sha256",
      "maintainer_identity",
      "approved_at",
      "approval_reference",
    ],
    [],
    where,
  );
  assertEnum(value.decision, ["awaiting", "approved", "rejected"], `${where}.decision`);
  assertNullableString(value.approved_checkpoint_sha256, `${where}.approved_checkpoint_sha256`);
  assertNullableString(value.maintainer_identity, `${where}.maintainer_identity`);
  assertNullableString(value.approved_at, `${where}.approved_at`);
  assertNullableString(value.approval_reference, `${where}.approval_reference`);

  if (value.decision === "approved") {
    assertSha256(value.approved_checkpoint_sha256, `${where}.approved_checkpoint_sha256`);
    if (value.approved_checkpoint_sha256 !== checkpointSha) {
      fail(`${where}.approved_checkpoint_sha256 must equal checkpoint_sha256`);
    }
    for (const key of ["maintainer_identity", "approved_at", "approval_reference"]) {
      assertString(value[key], `${where}.${key}`);
    }
  } else if (value.approved_checkpoint_sha256 !== null) {
    fail(`${where}.approved_checkpoint_sha256 must be null unless decision is approved`);
  }
}

function validateCheckpoint(value, where) {
  assertExactKeys(value, ["checkpoint_content", "checkpoint_sha256", "approval"], [], where);
  const refs = validateCheckpointContent(value.checkpoint_content, `${where}.checkpoint_content`);
  assertSha256(value.checkpoint_sha256, `${where}.checkpoint_sha256`);
  const expected = sha256Canonical(value.checkpoint_content);
  if (value.checkpoint_sha256 !== expected) fail(`${where}.checkpoint_sha256 mismatch`);
  validateApproval(value.approval, expected, `${where}.approval`);
  return refs;
}

function validateWorkflow(value, target, where) {
  assertExactKeys(
    value,
    ["mode", "procedure_path", "review_packet_path", "revision"],
    [],
    where,
  );
  assertEnum(value.mode, ["merged", "bootstrap"], `${where}.mode`);
  assertNullableString(value.procedure_path, `${where}.procedure_path`);
  assertNullableString(value.review_packet_path, `${where}.review_packet_path`);
  assertSha1(value.revision, `${where}.revision`);

  if (value.mode === "bootstrap") {
    if (value.procedure_path !== null || value.review_packet_path !== null) {
      fail(`${where} bootstrap mode requires null candidate workflow paths`);
    }
    if (value.revision !== target.base_sha) {
      fail(`${where}.revision must equal target.base_sha in bootstrap mode`);
    }
  } else {
    assertString(value.procedure_path, `${where}.procedure_path`);
    assertString(value.review_packet_path, `${where}.review_packet_path`);
  }
}

function validateTarget(value, where) {
  assertExactKeys(
    value,
    [
      "sha",
      "tree_sha",
      "pull_request_number",
      "pull_request_head_sha",
      "base_ref",
      "base_sha",
      "merge_base_sha",
      "changed_files",
    ],
    [],
    where,
  );
  assertSha1(value.sha, `${where}.sha`);
  assertSha1(value.tree_sha, `${where}.tree_sha`);
  if (value.pull_request_number !== null) {
    assertSafeInteger(value.pull_request_number, `${where}.pull_request_number`);
    assertSha1(value.pull_request_head_sha, `${where}.pull_request_head_sha`);
    if (value.sha !== value.pull_request_head_sha) {
      fail(`${where}.sha must equal pull_request_head_sha`);
    }
  } else if (value.pull_request_head_sha !== null) {
    fail(`${where}.pull_request_head_sha must be null when pull_request_number is null`);
  }
  assertString(value.base_ref, `${where}.base_ref`);
  assertSha1(value.base_sha, `${where}.base_sha`);
  assertSha1(value.merge_base_sha, `${where}.merge_base_sha`);
  assertSortedUniqueStrings(value.changed_files, `${where}.changed_files`, { nonEmpty: true });
}

function validateIssuePrSnapshot(value, where, root) {
  assertExactKeys(
    value,
    [
      "snapshot_id",
      "kind",
      "number",
      "source_reference",
      "captured_at",
      "content",
      "artifact_path",
      "sha256",
    ],
    [],
    where,
  );
  assertId(value.snapshot_id, `${where}.snapshot_id`);
  assertEnum(value.kind, ["issue", "pull_request", "comment", "other"], `${where}.kind`);
  assertSafeInteger(value.number, `${where}.number`);
  validateContentEnvelope(
    {
      source_reference: value.source_reference,
      captured_at: value.captured_at,
      content: value.content,
      artifact_path: value.artifact_path,
      sha256: value.sha256,
    },
    where,
    root,
  );
}

function validateExternalConstraint(value, where, root) {
  assertExactKeys(
    value,
    [
      "constraint_id",
      "purpose",
      "source_reference",
      "captured_at",
      "content",
      "artifact_path",
      "sha256",
    ],
    [],
    where,
  );
  assertId(value.constraint_id, `${where}.constraint_id`);
  assertString(value.purpose, `${where}.purpose`);
  validateContentEnvelope(
    {
      source_reference: value.source_reference,
      captured_at: value.captured_at,
      content: value.content,
      artifact_path: value.artifact_path,
      sha256: value.sha256,
    },
    where,
    root,
  );
}

function validateEvidence(value, where, root) {
  assertObject(value, where);
  if (value.kind === "repository") {
    assertExactKeys(value, ["evidence_id", "kind", "path", "revision", "purpose"], [], where);
    assertId(value.evidence_id, `${where}.evidence_id`);
    assertString(value.path, `${where}.path`);
    assertSha1(value.revision, `${where}.revision`);
    assertString(value.purpose, `${where}.purpose`);
    return;
  }
  if (value.kind === "artifact") {
    assertExactKeys(
      value,
      [
        "evidence_id",
        "kind",
        "purpose",
        "source_reference",
        "captured_at",
        "content",
        "artifact_path",
        "sha256",
      ],
      [],
      where,
    );
    assertId(value.evidence_id, `${where}.evidence_id`);
    assertString(value.purpose, `${where}.purpose`);
    validateContentEnvelope(
      {
        source_reference: value.source_reference,
        captured_at: value.captured_at,
        content: value.content,
        artifact_path: value.artifact_path,
        sha256: value.sha256,
      },
      where,
      root,
    );
    return;
  }
  fail(`${where}.kind must be repository or artifact`);
}

function validateCoverage(value, where) {
  assertExactKeys(value, ["subject_id", "perspective_ids"], [], where);
  assertId(value.subject_id, `${where}.subject_id`);
  assertSortedUniqueStrings(value.perspective_ids, `${where}.perspective_ids`, { nonEmpty: true });
}

function validateOutOfRange(value, where) {
  assertExactKeys(value, ["area", "reason", "owner_or_follow_up"], [], where);
  assertString(value.area, `${where}.area`);
  assertString(value.reason, `${where}.reason`);
  assertString(value.owner_or_follow_up, `${where}.owner_or_follow_up`);
}

function validateBatchContext(value, where, root) {
  assertExactKeys(
    value,
    [
      "schema",
      "context_id",
      "created_at",
      "repository",
      "workflow",
      "controlling_authorities",
      "target",
      "checkpoint",
      "issue_pr_snapshots",
      "external_constraints",
      "evidence",
      "coverage",
      "global_out_of_range",
      "known_evidence_gaps",
    ],
    [],
    where,
  );
  if (value.schema !== "aizign.review-batch-context/v1") {
    fail(`${where}.schema must be aizign.review-batch-context/v1`);
  }
  assertId(value.context_id, `${where}.context_id`);
  assertString(value.created_at, `${where}.created_at`);
  assertString(value.repository, `${where}.repository`);
  validateTarget(value.target, `${where}.target`);
  validateWorkflow(value.workflow, value.target, `${where}.workflow`);

  assertArray(value.controlling_authorities, `${where}.controlling_authorities`, {
    nonEmpty: true,
  });
  value.controlling_authorities.forEach((item, index) =>
    validateAuthority(item, `${where}.controlling_authorities[${index}]`),
  );
  assertUnique(
    value.controlling_authorities.map((item) => item.authority_id),
    `${where}.controlling_authorities authority IDs`,
  );

  const checkpointRefs = validateCheckpoint(value.checkpoint, `${where}.checkpoint`);
  const controllingAuthorityIds = new Set(
    value.controlling_authorities.map((item) => item.authority_id),
  );
  for (const authority of value.checkpoint.checkpoint_content.normative_authorities) {
    if (!controllingAuthorityIds.has(authority.authority_id)) {
      fail(
        `${where}.checkpoint authority ${authority.authority_id} is absent from controlling_authorities`,
      );
    }
  }

  assertArray(value.issue_pr_snapshots, `${where}.issue_pr_snapshots`, { nonEmpty: true });
  value.issue_pr_snapshots.forEach((item, index) =>
    validateIssuePrSnapshot(item, `${where}.issue_pr_snapshots[${index}]`, root),
  );
  assertUnique(
    value.issue_pr_snapshots.map((item) => item.snapshot_id),
    `${where}.issue_pr_snapshots snapshot IDs`,
  );

  assertArray(value.external_constraints, `${where}.external_constraints`);
  value.external_constraints.forEach((item, index) =>
    validateExternalConstraint(item, `${where}.external_constraints[${index}]`, root),
  );
  assertUnique(
    value.external_constraints.map((item) => item.constraint_id),
    `${where}.external_constraints constraint IDs`,
  );

  assertArray(value.evidence, `${where}.evidence`, { nonEmpty: true });
  value.evidence.forEach((item, index) =>
    validateEvidence(item, `${where}.evidence[${index}]`, root),
  );
  assertUnique(
    value.evidence.map((item) => item.evidence_id),
    `${where}.evidence evidence IDs`,
  );

  assertArray(value.coverage, `${where}.coverage`, { nonEmpty: true });
  value.coverage.forEach((item, index) =>
    validateCoverage(item, `${where}.coverage[${index}]`),
  );
  assertUnique(
    value.coverage.map((item) => item.subject_id),
    `${where}.coverage subject IDs`,
  );

  assertArray(value.global_out_of_range, `${where}.global_out_of_range`);
  value.global_out_of_range.forEach((item, index) =>
    validateOutOfRange(item, `${where}.global_out_of_range[${index}]`),
  );

  assertArray(value.known_evidence_gaps, `${where}.known_evidence_gaps`);
  value.known_evidence_gaps.forEach((item, index) =>
    validateGap(item, `${where}.known_evidence_gaps[${index}]`),
  );
  assertUnique(
    value.known_evidence_gaps.map((item) => item.gap_id),
    `${where}.known_evidence_gaps gap IDs`,
  );

  const perspectiveIds = new Set(checkpointRefs.assignmentsByPerspective.keys());
  const coverageMap = new Map();
  for (const item of value.coverage) {
    if (!checkpointRefs.subjectIds.has(item.subject_id)) {
      fail(`${where}.coverage references unknown subject ${item.subject_id}`);
    }
    for (const perspectiveId of item.perspective_ids) {
      if (!perspectiveIds.has(perspectiveId)) {
        fail(`${where}.coverage references unknown perspective ${perspectiveId}`);
      }
    }
    coverageMap.set(item.subject_id, new Set(item.perspective_ids));
  }

  for (const requiredSubjectId of checkpointRefs.requiredSubjectIds) {
    if (!coverageMap.has(requiredSubjectId)) {
      fail(`${where}.coverage is missing required subject ${requiredSubjectId}`);
    }
  }

  const derivedCoverage = new Map();
  for (const assignment of checkpointRefs.assignmentsByPerspective.values()) {
    for (const subjectId of assignment.subject_ids) {
      if (!derivedCoverage.has(subjectId)) derivedCoverage.set(subjectId, new Set());
      derivedCoverage.get(subjectId).add(assignment.perspective_id);
    }
  }

  for (const [subjectId, perspectives] of coverageMap.entries()) {
    const derived = derivedCoverage.get(subjectId) ?? new Set();
    if (JSON.stringify([...perspectives].sort()) !== JSON.stringify([...derived].sort())) {
      fail(`${where}.coverage for ${subjectId} does not match checkpoint review assignments`);
    }
  }

  return checkpointRefs;
}

function validatePacket(packet, filePath, root) {
  const where = path.basename(filePath);
  assertExactKeys(
    packet,
    [
      "schema",
      "packet_id",
      "packet_sha256",
      "batch_id",
      "batch_context_sha256",
      "batch_context",
      "assignment",
    ],
    [],
    where,
  );
  if (packet.schema !== "aizign.review-packet/v1") {
    fail(`${where}.schema must be aizign.review-packet/v1`);
  }
  assertId(packet.packet_id, `${where}.packet_id`);
  assertSha256(packet.packet_sha256, `${where}.packet_sha256`);
  assertId(packet.batch_id, `${where}.batch_id`);
  assertSha256(packet.batch_context_sha256, `${where}.batch_context_sha256`);
  const refs = validateBatchContext(packet.batch_context, `${where}.batch_context`, root);
  validateReviewAssignment(packet.assignment, `${where}.assignment`);

  const expectedAssignment = refs.assignmentsByPerspective.get(
    packet.assignment.perspective_id,
  );
  if (!expectedAssignment) {
    fail(`${where}.assignment perspective is not defined by the checkpoint`);
  }
  if (canonical(packet.assignment) !== canonical(expectedAssignment)) {
    fail(`${where}.assignment differs from the checkpoint review assignment`);
  }

  const expectedContext = sha256Canonical(packet.batch_context);
  if (packet.batch_context_sha256 !== expectedContext) {
    fail(`${where}.batch_context_sha256 mismatch`);
  }

  const packetForDigest = structuredClone(packet);
  delete packetForDigest.packet_sha256;
  const expectedPacket = sha256Canonical(packetForDigest);
  if (packet.packet_sha256 !== expectedPacket) fail(`${where}.packet_sha256 mismatch`);

  return {
    packet,
    canonicalContext: canonical(packet.batch_context),
    expectedPerspectiveIds: new Set(refs.assignmentsByPerspective.keys()),
  };
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    fail(
      "usage: node scripts/validate-review-batch.mjs <packet-1.json> <packet-2.json> ...",
    );
  }

  const root = process.cwd();
  const validated = files.map((file) => {
    const resolved = path.resolve(file);
    let packet;
    try {
      packet = JSON.parse(fs.readFileSync(resolved, "utf8"));
    } catch (error) {
      fail(`${file}: cannot read or parse JSON: ${error.message}`);
    }
    return validatePacket(packet, resolved, root);
  });

  const first = validated[0];
  for (const item of validated.slice(1)) {
    if (item.packet.batch_id !== first.packet.batch_id) {
      fail("all packets must have the same batch_id");
    }
    if (item.packet.batch_context_sha256 !== first.packet.batch_context_sha256) {
      fail("all packets must have the same batch_context_sha256");
    }
    if (item.canonicalContext !== first.canonicalContext) {
      fail("all packets must contain byte-equivalent canonical batch_context data");
    }
  }

  assertUnique(
    validated.map((item) => item.packet.packet_id),
    "batch packet IDs",
  );
  assertUnique(
    validated.map((item) => item.packet.assignment.perspective_id),
    "batch perspective IDs",
  );

  const actualPerspectives = new Set(
    validated.map((item) => item.packet.assignment.perspective_id),
  );
  const expectedPerspectives = first.expectedPerspectiveIds;
  if (
    JSON.stringify([...actualPerspectives].sort()) !==
    JSON.stringify([...expectedPerspectives].sort())
  ) {
    const missing = [...expectedPerspectives].filter((id) => !actualPerspectives.has(id));
    const extra = [...actualPerspectives].filter((id) => !expectedPerspectives.has(id));
    fail(
      `batch perspective packet set mismatch; missing=[${missing.join(",")}], extra=[${extra.join(",")}]`,
    );
  }

  console.log(
    `validated ${validated.length} packet(s) for batch ${first.packet.batch_id}`,
  );
  console.log(`batch_context_sha256=${first.packet.batch_context_sha256}`);
  for (const item of validated.sort((a, b) =>
    a.packet.assignment.perspective_id.localeCompare(
      b.packet.assignment.perspective_id,
    ),
  )) {
    console.log(
      `${item.packet.assignment.perspective_id}: ${item.packet.packet_id} ${item.packet.packet_sha256}`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(`review batch validation failed: ${error.message}`);
  process.exitCode = 1;
}
