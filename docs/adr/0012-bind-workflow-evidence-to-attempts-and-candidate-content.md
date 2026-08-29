# ADR-0012: Bind workflow evidence to attempts and candidate content

- Status: Accepted
- Date: 2026-08-24
- Related: ADR-0003, ADR-0004, ADR-0007, Issue #47, PR #50

> **Partial supersession:** [ADR-0027](0027-remove-the-dsh-harness-evidence-read-surface.md)
> supersedes only this ADR's two list items describing current DSH
> `bindingDigest` and `payloadDigest` as harness-session-evidence digests.
> Candidate binding, `attemptId`, `candidateDigest`, candidate content
> authority, comparison order, duplicate/conflict behavior, and deferred
> external artifact evidence remain Accepted.

## Context

Hard invariant 5 requires workflow evidence to identify the workflow, assignment, execution attempt, and candidate revision it describes. The first `workflow.signal.submit` slice carried workflow, assignment, role, and a human/provider-facing revision identifier, but omitted `AttemptId` and candidate content identity.

An `ArtifactRevision` alone does not identify the bytes reviewed by an assignment. The core already has a typed `Digest` vocabulary, but it has no access to candidate bytes and must not claim to calculate or verify their hash. The control plane or artifact authority that can read those bytes owns that responsibility.

Protocol v1 and journal schema v1 have not been published in a GitHub Release or registry package. They are being hardened before their first contract freeze under Issue #44.

## Decision

Update Protocol v1 and journal schema v1 in place. Old frames and journal records without the new required binding fields are rejected. A version bump would imply compatibility with a published v1 contract that does not exist and would preserve a shape known to violate a hard invariant.

Treat the candidate binding as one conceptual pair:

```text
CandidateBinding
├── artifactRevision
└── candidateDigest
```

At the domain boundary, `ExpectedAssignment` and `WorkflowSignal` carry the pair as typed `ArtifactRevision` and `Digest` fields. Protocol and journal DTOs use the required parallel fields `artifactRevision` and `candidateDigest`; introducing a nested object would add another representation without improving the current closed schema. The serialized digest shape is:

```json
{ "algorithm": "sha256", "hex": "<64 lowercase hexadecimal digits>" }
```

`sha256` is the only v0.1 algorithm. Adding another algorithm is a protocol and journal contract change; decoders reject unknown algorithms.

Add required `attemptId` and `candidateDigest` fields to both `expected` and `signal`. The expectation comparison order is fixed as workflow → assignment → attempt → role → candidate revision identifier → candidate digest. Expectation checks run before event duplicate/conflict classification.

The control plane or artifact authority computes `candidateDigest` from candidate bytes and fixes it in adapter configuration. The core validates the digest shape and carries and compares the value; it does not read candidate bytes or recalculate the digest. The DSH adapter injects attempt and candidate binding from configuration, and does not expose workflow, assignment, attempt, candidate identity, or candidate digest in model-visible tool parameters, arguments, or prompt text.

Candidate binding is local to the submitted command and accepted event content. Workflow state does not maintain an `artifactRevision -> candidateDigest` registry. Different event identities may therefore use the same revision identifier with different digests when each event matches its own control-plane expectation. Reusing one `eventId` with a changed attempt, revision, candidate digest, or other signal content remains `EVENT_CONFLICT`; an exact retransmission remains `duplicate`, including after journal replay.

The candidate content digest is distinct from:

- DSH `bindingDigest`, which checks adapter configuration identity against harness session evidence;
- DSH `payloadDigest`, which checks the submitted structured signal against harness session evidence;
- a future external evidence artifact digest, whose authority, verification, and semantic use are not defined here.

External artifact digest immutability, review/repair causation identity, findings consumption, and repair-chain state are deferred to separate Issues and ADRs. Existing `artifactRef` semantics are unchanged.

## Consequences

### Positive

- Accepted and replayed evidence identifies the exact execution attempt and candidate pair supplied by the control plane.
- Attempt, revision, and candidate digest mismatches fail with stable, ordered codes.
- Event duplicate/conflict comparison includes the new attempt and candidate content fields automatically.
- Rust, TypeScript, JSON Schema, journal runtime, and the DSH adapter share one explicit shape.
- The contract does not overstate what the core can verify without access to candidate bytes.

### Negative / Risks

- Every producer must obtain a candidate digest from an authority that can read the candidate bytes.
- Existing pre-release state files using the earlier v1 shape cannot be opened and must be discarded or migrated explicitly before use.
- Only SHA-256 is available in v0.1.
- This decision does not prevent separate events from assigning different content to the same revision identifier; any global candidate lifecycle invariant requires its own state model and ADR.

## Follow-up

- Define external evidence artifact provenance separately before adding a model- or provider-supplied digest.
- Define review/repair causation and any single-consumer policy as a dedicated state-machine slice.
- Keep adapter tests proving candidate identity and digest are absent from all model-visible inputs.

## Alternatives considered

- **Version Protocol and journal as v2.** Rejected because no v1 artifact has been released or frozen; preserving the incomplete shape would create compatibility debt without a consumer.
- **Use a nested `candidate` DTO.** Rejected for v0.1 because the existing revision field is already part of the closed protocol; two required parallel fields express one conceptual domain pair with less migration surface.
- **Let the model supply candidate identity or digest.** Rejected because assignment identity and candidate content provenance are control-plane responsibilities and must not become prompt-controlled.
- **Maintain a global revision-to-digest registry.** Deferred. It requires an explicit workspace/candidate lifecycle and would reject otherwise valid event-local bindings beyond the scope of Issue #47.
- **Include external evidence digests and repair causation now.** Deferred because those values have different authorities and require provenance and repair-chain policies that candidate binding alone does not establish.
