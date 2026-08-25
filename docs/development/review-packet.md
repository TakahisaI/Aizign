# Fixed review packets

## Status and authority

This file is the required fixed-context interface delegated by
[`change-workflow.md`](change-workflow.md) for Boundary and Milestone reviews.
It defines workflow evidence, not product or runtime authority.

A review packet prevents each reviewer from independently reconstructing
mutable Issue, pull-request, CI, milestone, or release context. It does not
prove that a claim is correct. Breakers still inspect the exact source and a
separate Adjudicator still verifies their findings.

## Batch model

A targeted review has:

- one frozen shared `batch_context`;
- one coverage map for the declared claims and ranges;
- one packet per perspective; and
- one fresh Breaker session per packet.

All packets in a batch contain byte-equivalent canonical `batch_context` data
and the same `batch_context_sha256`. Only `packet_id`, `packet_sha256`, and the
single `assignment` differ.

The packet is frozen when the first Breaker session begins.

## Required binding

### Repository and workflow

Record:

- repository identity;
- `GOVERNANCE.md` path;
- `CONTRIBUTING.md` path;
- workflow and review-packet paths; and
- exact workflow revision.

### Target and comparison base

Record:

- target commit SHA;
- target tree SHA;
- pull-request number and head SHA when applicable;
- base ref;
- base SHA; and
- merge-base SHA.

A pull-request review uses the merge base to define the changed range. A target
SHA alone is insufficient when the base branch can move.

Useful read-only commands include:

```sh
git rev-parse <target-sha>
git rev-parse '<target-sha>^{tree}'
git merge-base <base-sha> <target-sha>
git diff <merge-base-sha>..<target-sha>
git show --stat --oneline <target-sha>
```

### Approved checkpoint

Record:

- checkpoint ID;
- exact checkpoint snapshot or retained artifact;
- checkpoint SHA-256;
- accepted contract or decision revision;
- approving Maintainer identity;
- approval reference; and
- approval timestamp.

A GitHub comment permalink is provenance, not immutability. The digest binds
the exact checkpoint content. Editing an approved checkpoint creates a new
checkpoint ID, digest, approval, and review batch where applicable.

### Authority and external constraints

For repository authorities, record path, exact revision, relevant section, and
purpose.

When a review depends on an external format or official tool contract, record
the official source identity, capture time, retained snapshot or artifact,
snapshot digest, and purpose. A live web page is not silently substituted for
the frozen constraint during a review.

### Frozen mutable context

Freeze the Issue and pull-request statements that define the claim under
review. Each snapshot records:

- kind and number;
- source reference;
- capture time;
- inline content or retained artifact; and
- SHA-256 digest.

A later comment or status update is not injected into an active review without
an explicit supplemental review or a new batch when it changes binding
context.

### Evidence, ranges, and coverage

Record:

- evidence paths or retained artifacts and their purpose;
- included commitment, lifecycle, and consumer ranges;
- global out-of-range areas;
- known evidence gaps; and
- a coverage map from every included claim/range to one or more perspective
  IDs.

An included claim or range with no perspective is `INCOMPLETE` and prevents the
batch from starting.

## Packet interface

Use this JSON interface:

```json
{
  "schema": "aizign.review-packet/v1",
  "packet_id": "issue-94-pr-123-0123456789ab-pa1",
  "packet_sha256": "sha256:<digest>",
  "batch_id": "issue-94-pr-123-0123456789ab",
  "batch_context_sha256": "sha256:<digest>",
  "batch_context": {
    "context_id": "issue-94-pr-123-0123456789ab-context-v1",
    "created_at": "2026-08-25T00:00:00Z",
    "repository": "TakahisaI/Aizign",
    "workflow": {
      "governance_path": "GOVERNANCE.md",
      "contribution_policy_path": "CONTRIBUTING.md",
      "procedure_path": "docs/development/change-workflow.md",
      "review_packet_path": "docs/development/review-packet.md",
      "revision": "0123456789abcdef0123456789abcdef01234567"
    },
    "target": {
      "sha": "0123456789abcdef0123456789abcdef01234567",
      "tree_sha": "89abcdef0123456789abcdef0123456789abcdef",
      "pull_request_number": 123,
      "pull_request_head_sha": "0123456789abcdef0123456789abcdef01234567",
      "base_ref": "main",
      "base_sha": "fedcba9876543210fedcba9876543210fedcba98",
      "merge_base_sha": "fedcba9876543210fedcba9876543210fedcba98"
    },
    "contract_checkpoint": {
      "checkpoint_id": "issue-94-checkpoint-v1",
      "accepted_contract_revision": "<immutable reference>",
      "snapshot": {
        "source_reference": "<provenance permalink>",
        "content": "<exact checkpoint content>",
        "artifact_ref": null,
        "sha256": "sha256:<digest>"
      },
      "approved_by": "<Maintainer identity>",
      "approval_reference": "<approval permalink or immutable record>",
      "approved_at": "2026-08-25T00:00:00Z"
    },
    "normative_authorities": [
      {
        "path": "docs/architecture/invariants.md",
        "revision": "0123456789abcdef0123456789abcdef01234567",
        "section": "Invariant 10",
        "purpose": "Defines the affected hard invariant"
      }
    ],
    "external_constraints": [],
    "issue_pr_snapshots": [
      {
        "kind": "issue",
        "number": 94,
        "source_reference": "<source permalink>",
        "captured_at": "2026-08-25T00:00:00Z",
        "content": "<exact frozen content>",
        "artifact_ref": null,
        "sha256": "sha256:<digest>"
      }
    ],
    "evidence": [
      {
        "path": "<repository path, test, fixture, or artifact>",
        "revision": "0123456789abcdef0123456789abcdef01234567",
        "purpose": "<why this evidence is relevant>"
      }
    ],
    "declared_ranges": {
      "commitment": ["PROCESS"],
      "lifecycle": ["review batch", "adjudication"],
      "consumer": ["coding agents", "repository documentation"]
    },
    "coverage_map": [
      {
        "claim_or_range": "Maintainer authority is preserved",
        "perspective_ids": ["PA-1"]
      }
    ],
    "global_out_of_range": [
      {
        "area": "product/runtime behavior",
        "reason": "The candidate changes process documents only",
        "owner_or_follow_up": "none"
      }
    ],
    "known_evidence_gaps": [],
    "session_requirements": {
      "fresh_session_required": true,
      "other_breaker_reports_visible": false,
      "repository_writes_allowed": false,
      "github_writes_allowed": false
    }
  },
  "assignment": {
    "perspective_id": "PA-1",
    "title": "Governance and authority",
    "question": "Does the candidate preserve Maintainer authority and avoid hidden product authority?",
    "failure_models": [
      "A model Conductor can be read as approving or merging the change"
    ],
    "ranges": {
      "commitment": ["PROCESS"],
      "lifecycle": ["Maintainer approval", "merge authorization"],
      "consumer": ["Maintainers", "coding agents"]
    },
    "required_checks": [
      "GOVERNANCE.md",
      "CONTRIBUTING.md",
      "docs/development/change-workflow.md"
    ],
    "assignment_out_of_range": [
      "product implementation correctness"
    ]
  }
}
```

`content` and `artifact_ref` are mutually exclusive. Use inline content when it
is reasonably bounded and available to every reviewer. Use a retained artifact
only when every required session can resolve the same immutable bytes.

A nullable pull-request field is allowed only when the target is not a pull
request. Any absence that affects the assigned claim is also recorded as a
known evidence gap.

## Canonical JSON and digest verification

Canonical JSON is UTF-8 JSON with object keys sorted lexicographically, array
order preserved, Unicode preserved, and no insignificant whitespace. Numbers
must be safe integers; use strings for timestamps, versions, and identifiers.

The following command uses the repository-pinned Node.js runtime. It prints the
expected values by default and exits nonzero when `VERIFY=1` and the stored
values do not match.

```sh
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const packet = JSON.parse(fs.readFileSync("review-packet.json", "utf8"));

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("review packets permit safe integers only");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

function sha256(value) {
  return "sha256:" + crypto.createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

const expectedContext = sha256(packet.batch_context);
const packetForDigest = structuredClone(packet);
delete packetForDigest.packet_sha256;
packetForDigest.batch_context_sha256 = expectedContext;
const expectedPacket = sha256(packetForDigest);

console.log(`batch_context_sha256=${expectedContext}`);
console.log(`packet_sha256=${expectedPacket}`);

if (process.env.VERIFY === "1") {
  if (packet.batch_context_sha256 !== expectedContext) {
    throw new Error("batch_context_sha256 mismatch");
  }
  if (packet.packet_sha256 !== expectedPacket) {
    throw new Error("packet_sha256 mismatch");
  }
}
NODE
```

Creation sequence:

1. create the packet with placeholder digest values;
2. run the command and set `batch_context_sha256` and `packet_sha256` to the
   printed values;
3. run the same command with `VERIFY=1`;
4. do not start a Breaker session unless verification succeeds.

## Invalidation

Create a new batch ID and new packets when any binding input changes:

- target SHA or tree SHA;
- base SHA or merge-base SHA;
- approved checkpoint content, digest, or approval;
- workflow revision;
- normative authority set;
- frozen Issue or pull-request claim context;
- included range or coverage map; or
- known evidence gap.

### Binding context and observational evidence

A change to binding context invalidates the batch.

Later observational evidence, such as a CI job becoming green or a new
non-binding comment, is not silently added. Check it separately at merge
readiness or create a supplemental review/new batch when it materially changes
adjudication.

## Manual equivalent: Conductor packet preparation

1. resolve the exact repository, target, tree, base, and merge-base;
2. verify the workflow revision and approved checkpoint snapshot/digest;
3. freeze the Issue, pull-request, authority, and external-constraint context;
4. record all included ranges, out-of-range areas, and known gaps;
5. derive bounded perspectives from the checkpoint and failure models;
6. map every included claim/range to one or more perspective IDs;
7. copy one identical `batch_context` into one packet per perspective;
8. add exactly one assignment to each packet;
9. compute and verify both digests; and
10. start no reviewer until every required packet is valid.

## Manual equivalent: Breaker

1. start a fresh session with exactly one packet and no other Breaker report;
2. verify the target/base binding, workflow revision, checkpoint, and digests;
3. read the authorities at the revisions named in the packet;
4. investigate only the assigned perspective and ranges;
5. construct a candidate counterexample or failure sequence;
6. inspect exact source, tests, specifications, and retained snapshots;
7. distinguish observed fact from inference;
8. classify each candidate as `established`, `not established`, or
   `incomplete`;
9. cite exact repository evidence; and
10. return findings only.

If another Breaker report is visible in the session, return:

```text
status: CONTAMINATED
reason: another Breaker report was visible
required_action: start a new fresh session with only this packet
```

Do not claim the report was successfully ignored after it entered the session.

### Breaker output

```markdown
# Aizign Breaker report

## Review identity

- packet_id:
- packet_sha256:
- batch_id:
- perspective_id:
- workflow_revision:
- target_sha:
- target_tree_sha:
- base_sha:
- merge_base_sha:
- other Breaker reports visible: false
- repository/GitHub writes performed: none

## Assigned range

- commitment:
- lifecycle:
- consumer:
- explicit out-of-range areas:

## Claim and candidate counterexample

- claim:
- candidate counterexample or failure sequence:

## Evidence inspected

List exact paths, symbols, tests, fixtures, and snapshot references.

## Findings

### <perspective-id>-<number>: <title>

- status: established | not established | incomplete
- basis: observed fact | inference
- repository evidence:
- concrete counterexample or failure sequence:
- affected range:
- correction or claim reduction required:
- evidence still required:

## Checked and held

List assigned claims deliberately checked without an established counterexample.

## Evidence gaps

List every incomplete area and required evidence.

## Out-of-range referrals

List possible concerns without investigating or assigning severity.
```

## Manual equivalent: Adjudicator

1. start another fresh session after all required uncontaminated reports arrive;
2. verify target, base, workflow, checkpoint, packet, digest, coverage, and
   report identity consistency;
3. create a source-finding register covering every raw finding;
4. reinspect source and authority evidence independently;
5. classify each source finding as `established`, `rejected`, or `incomplete`;
6. integrate only findings with the same causal mechanism, affected
   commitment, broken claim, and minimal disposition;
7. assign severity from verified impact rather than report count;
8. choose implementation correction, path deletion, claim reduction,
   provisional status, or bounded defer;
9. state the proof required before the next transition; and
10. recommend the next workflow state without authorizing merge or release.

A bounded defer is complete only when it records the known limitation, impact,
safe current boundary, owner, re-evaluation trigger, retained evidence, and
compatibility or migration treatment where applicable. The current Foundation
campaign may label such a complete campaign-specific defer `D1`; the generic
workflow does not make `D1` a permanent taxonomy.

### Adjudicator output

```markdown
# Aizign adjudication

## Adjudication identity

- batch_id:
- workflow_revision:
- target_sha:
- target_tree_sha:
- base_sha:
- merge_base_sha:
- checkpoint_id:
- batch_context_sha256:
- packets_received:
- reports_received:
- reports_complete:
- repository/GitHub writes performed: none

## Batch integrity

Record workflow, packet, target, checkpoint, range, digest, coverage, and report
consistency.

## Source-finding disposition

| Source finding | Status | Independently verified evidence | Root cause | Reason |
|---|---|---|---|---|

## Root-cause register

For each root cause record severity, affected ranges, source findings,
independently verified evidence, causal mechanism, failure sequence, broken
claim or authority, disposition, required proof, compatibility/migration
handling, and confidence.

## Rejected findings

State the source verification that supports rejection.

## Incomplete findings and evidence gaps

Do not collapse these into rejection or no finding.

## Next workflow state recommendation

Choose and justify one:

- `proposed`;
- `implementing`;
- `evidence complete`;
- `reviewed`;
- `adjudicated` and ready for Conductor transition-readiness assessment.
```

## Manual parity

A skill-assisted run and a manual run are materially equivalent when they use
the same workflow revision, exact target/base binding, approved checkpoint,
frozen batch context, assigned ranges, coverage map, digests, and output
requirements.

Differences in prose are not material. Differences in authority, revision,
range, evidence status, coverage, or disposition require Conductor review.
