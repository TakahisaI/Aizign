# Fixed review packets

## Status and authority

This file is the fixed-context interface delegated by
[`change-workflow.md`](change-workflow.md) for Boundary and Milestone reviews.
It defines workflow evidence, not product or runtime authority.

The closed packet shape is
[`review-packet.schema.json`](review-packet.schema.json). Validate every packet
for one batch together with:

```sh
node scripts/validate-review-batch.mjs <packet-1.json> <packet-2.json> ...
```

The validator uses the repository-pinned Ajv dependency and adds no new runtime
or development dependency. Digest agreement alone is not packet validity.

## Batch model

A targeted review contains:

- one canonical, frozen `batch_context`;
- one approved checkpoint envelope;
- stable claim, range, evidence-requirement, gap, and perspective IDs;
- one packet per perspective; and
- one fresh Breaker session per packet.

All packets contain byte-equivalent canonical `batch_context` data. Only
`packet_id`, `packet_sha256`, and the single `assignment` differ.

Freeze the batch only after all packet files pass one batch-wide validation
command and before the first Breaker session starts.

## Execution adapter

Every batch freezes the instruction source used by the reviewer.

`execution_adapter.mode` is:

- `manual`: `instruction_constraint_id` resolves to an inline or retained
  immutable manual instruction in `external_constraints`; or
- `skill`: the packet also records `skill_name`, `skill_version`, and
  `skill_sha256`, and the digest equals the referenced frozen skill-instruction
  constraint.

The initial Issue #94 / PR #95 bootstrap **must** use:

```json
{
  "mode": "manual",
  "instruction_constraint_id": "<frozen manual instruction constraint>"
}
```

Do not invoke `$aizign-break` or `$aizign-adjudicate` for that initial
bootstrap. Those personal/workspace skills are not repository authority and are
smoke-tested only after the tracked workflow merges.

## Required binding

### Controlling authorities

Record each controlling authority with:

- stable authority ID;
- repository path;
- exact revision;
- relevant section; and
- purpose.

For bootstrap mode, every controlling authority revision must equal the target
base SHA. Candidate workflow files are evidence under review, not controlling
authority.

### Workflow mode

Record either:

- `merged`: the last merged procedure and packet paths at one exact revision;
  or
- `bootstrap`: both candidate procedure paths are `null`, and the workflow
  revision equals the target base SHA.

### Target and comparison base

Record:

- target commit SHA;
- target tree SHA;
- pull-request number and head SHA when applicable;
- base ref;
- base SHA;
- merge-base SHA; and
- exact changed-file paths.

A PR target requires exactly one frozen `pull_request` snapshot whose number
matches `target.pull_request_number`.

### Checkpoint content, digest, and approval

The checkpoint has three distinct records:

```text
checkpoint_content
checkpoint_sha256 = SHA-256(canonical(checkpoint_content))
approval
```

`checkpoint_content` contains:

- checkpoint ID and controlling workflow revision;
- change class and implementation scope;
- `contract_revision` and `contract_snapshot_id`;
- authorities, owners, and old-path disposition;
- claims and ranges;
- evidence requirements;
- review assignments; and
- known evidence gaps.

`contract_snapshot_id` must resolve to one exact frozen Issue, PR, comment, or
other snapshot in the batch.

The approval envelope is outside the checkpoint hash input.

For `decision: approved`, all of these are mandatory:

- `approved_checkpoint_sha256` equal to the calculated digest;
- non-blank `maintainer_identity`;
- valid RFC 3339 `approved_at`;
- non-blank `approval_reference`.

For `decision: awaiting`, all approval metadata is `null`. A rejected decision
records non-blank identity/reference and a valid timestamp, but no approved
digest.

### Frozen mutable context

Freeze every Issue and PR body that defines the reviewed claim. Each snapshot
records:

- stable snapshot ID;
- kind and number;
- source reference;
- RFC 3339 capture time;
- exactly one of inline `content` or repository-relative `artifact_path`; and
- SHA-256 of the exact bytes.

Do not edit a frozen batch comment. Any binding change creates a new checkpoint
where needed, a new batch ID, new packets, and a new comment.

### Claims, ranges, evidence, gaps, and coverage

The three structured range kinds are:

- commitment;
- lifecycle; and
- consumer.

Proof and review are separate structures:

- `claims[]` — stable claim ID, statement, authorities, and falsification;
- `evidence_requirements[]` — stable evidence ID, subject IDs, concrete method,
  expected detection, owner, and `evidence_ref_ids`;
- `review_assignments[]` — one perspective and its assigned stable subjects;
- `coverage[]` — exact subject-to-perspective mapping.

Each claim and each range whose disposition is `included` or `evidence_gap`
must be referenced by at least one evidence requirement. Every
`evidence_ref_id` must resolve to a repository or retained evidence record in
the batch.

Every claim, reviewable range, evidence requirement, and unresolved evidence
gap must appear in one or more review assignments and in the matching coverage
entry. An unassigned gap prevents batch validation.

### Evidence records

Repository evidence records:

- stable evidence ID;
- repository path;
- exact revision; and
- purpose.

Retained artifact evidence records:

- stable evidence ID;
- purpose and source;
- capture time;
- exactly one of content or repository-relative artifact path; and
- verified SHA-256.

Artifact paths are checked lexically and after `realpath`. A path or symlink
that resolves outside the repository root is rejected.

## Closed-interface validation

The batch validator rejects at least:

- missing or unknown fields;
- wrong schema identifiers, types, enums, or SHA shapes;
- unsafe or malformed timestamps;
- blank approval provenance;
- target SHA / PR-head mismatch;
- bootstrap authority revisions that are not the base SHA;
- bootstrap use of a personal/workspace skill;
- a PR target without exactly one matching PR snapshot;
- a checkpoint whose contract snapshot does not exist;
- checkpoint, nested-content, batch-context, or packet digest mismatch;
- content/artifact envelopes with neither or both values;
- artifact paths or symlinks escaping the repository root;
- duplicate or dangling IDs;
- a claim or reviewable range with no evidence requirement;
- an evidence requirement with no resolvable evidence reference;
- an unresolved gap with no assignment;
- coverage that differs from assignments;
- different contexts in one batch; and
- duplicate or missing perspective packets.

A successful exit means the supplied files form one internally consistent
batch. It does not prove that the selected claims are complete or true.

## Canonical digest rules

Canonical JSON uses UTF-8, lexicographically sorted object keys, preserved array
order, preserved Unicode, no insignificant whitespace, and safe integers only.

```text
checkpoint_sha256 = SHA-256(canonical(checkpoint_content))
batch_context_sha256 = SHA-256(canonical(batch_context))
packet_sha256 = SHA-256(canonical(packet with packet_sha256 omitted))
```

Order-insensitive ID arrays required by the interface are sorted before the
hash is finalized.

## Minimal packet skeleton

The schema is authoritative. This abbreviated skeleton shows the relationship
between the records:

```json
{
  "schema": "aizign.review-packet/v1",
  "packet_id": "issue-94-pr-95-<head>-pa1",
  "packet_sha256": "sha256:<digest>",
  "batch_id": "issue-94-pr-95-<head>-v6",
  "batch_context_sha256": "sha256:<digest>",
  "batch_context": {
    "schema": "aizign.review-batch-context/v1",
    "context_id": "issue-94-pr-95-<head>-context-v6",
    "created_at": "2026-08-25T00:00:00Z",
    "repository": "TakahisaI/Aizign",
    "workflow": {
      "mode": "bootstrap",
      "procedure_path": null,
      "review_packet_path": null,
      "revision": "<base SHA>"
    },
    "execution_adapter": {
      "mode": "manual",
      "instruction_constraint_id": "EXEC-MANUAL-BOOTSTRAP-V1"
    },
    "controlling_authorities": [],
    "target": {
      "sha": "<target SHA>",
      "tree_sha": "<tree SHA>",
      "pull_request_number": 95,
      "pull_request_head_sha": "<target SHA>",
      "base_ref": "main",
      "base_sha": "<base SHA>",
      "merge_base_sha": "<merge-base SHA>",
      "changed_files": []
    },
    "checkpoint": {
      "checkpoint_content": {
        "schema": "aizign.checkpoint/v1",
        "checkpoint_id": "<checkpoint ID>",
        "workflow_revision": "<base SHA>",
        "change_class": "Boundary change",
        "contract_revision": "<human-readable revision>",
        "contract_snapshot_id": "SNAP-ISSUE-94",
        "normative_authorities": [],
        "canonical_owners": [],
        "duplicate_owners_to_remove": [],
        "old_path_dispositions": [],
        "claims": [],
        "ranges": [],
        "evidence_requirements": [],
        "review_assignments": [],
        "implementation_scope": "review-only",
        "known_evidence_gaps": []
      },
      "checkpoint_sha256": "sha256:<checkpoint digest>",
      "approval": {
        "decision": "approved",
        "approved_checkpoint_sha256": "sha256:<same checkpoint digest>",
        "maintainer_identity": "<Maintainer>",
        "approved_at": "2026-08-25T00:00:00Z",
        "approval_reference": "<immutable approval reference>"
      }
    },
    "issue_pr_snapshots": [],
    "external_constraints": [],
    "evidence": [],
    "coverage": [],
    "global_out_of_range": [],
    "known_evidence_gaps": []
  },
  "assignment": {
    "perspective_id": "PA-1",
    "title": "Governance and authority",
    "question": "<bounded question>",
    "failure_models": ["<failure model>"],
    "subject_ids": ["<stable subject ID>"],
    "required_checks": ["<path or evidence ID>"],
    "assignment_out_of_range": []
  }
}
```

The placeholder skeleton is not valid until all required arrays, values,
digests, references, and perspective packets are complete.

## Invalidation

Create a new batch when any binding input changes, including:

- target SHA/tree, base, merge-base, or changed paths;
- checkpoint content, digest, or approval;
- workflow mode or controlling authority revision;
- execution adapter or its frozen instructions;
- Issue/PR/constraint snapshot;
- claim, range, evidence requirement/reference, gap, assignment, or coverage;
- retained evidence.

Later observational evidence, such as a CI job becoming green, is checked at
merge or milestone readiness unless it changes a reviewed claim. Do not inject
it silently into an active batch.

## Initial Issue #94 bootstrap procedure

For the initial workflow review:

1. use base-revision governance and contribution policy only as controlling
   authority;
2. set `execution_adapter.mode` to `manual`;
3. freeze the exact manual Breaker/Adjudicator instructions inline in
   `external_constraints`;
4. freeze the Issue #94 body and exact PR #95 body;
5. list every changed path;
6. approve the exact checkpoint digest separately;
7. validate all PA-1/PA-2/PA-3 packets together;
8. post a new, unedited batch record for that exact head;
9. run each packet in a separate ordinary fresh session without an Aizign skill;
10. run the fixed manual Adjudicator instruction in another ordinary fresh
    session; and
11. obtain a separate Maintainer merge decision.

Previously installed Codex skills are not bootstrap evidence. They are used
only for post-merge skill/manual smoke checks and later changes.

## Fixed manual Breaker instruction

The bootstrap constraint supplied in every packet must instruct the reviewer to:

1. use only the packet, exact target, base authorities, and named evidence;
2. inspect only the assigned stable subjects and failure models;
3. construct concrete counterexamples;
4. distinguish observed fact from inference;
5. classify candidates as `established`, `not established`, or `incomplete`;
6. cite exact source evidence;
7. return findings only; and
8. stop as `CONTAMINATED` if another Breaker report is visible.

The Breaker does not edit, integrate, assign final severity, or recommend merge.

## Fixed manual Adjudicator instruction

The bootstrap constraint supplied for adjudication must instruct a separate
fresh session to:

1. revalidate the complete packet batch;
2. verify every report-to-packet identity;
3. reinspect exact source and controlling authority independently;
4. classify every raw finding as `established`, `rejected`, or `incomplete`;
5. integrate only materially identical root causes;
6. assign severity from verified impact, not report count;
7. state correction and required proof; and
8. recommend the next workflow state without authorizing merge or release.

## Manual packet preparation

1. resolve exact target, tree, base, merge-base, and changed paths;
2. freeze controlling authorities and mutable snapshots;
3. prepare checkpoint content and compute its canonical digest;
4. record a separate approval envelope;
5. define stable claims, ranges, evidence requirements/references, gaps, and
   assignments;
6. freeze execution instructions;
7. copy one identical context into one packet per perspective;
8. compute all nested, context, and packet digests; and
9. validate all packet files together before starting review.
