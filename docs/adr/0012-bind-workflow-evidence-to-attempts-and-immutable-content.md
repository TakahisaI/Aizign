# ADR-0012: Bind workflow evidence to attempts and immutable content

- Status: Accepted
- Date: 2026-08-24
- Related: ADR-0003, ADR-0004, ADR-0007, Issue #47, PR #50

## Context

Hard invariant 5 requires every piece of workflow evidence to be bound to a workflow, assignment, attempt, and candidate revision. The first `workflow.signal.submit` slice carried workflow, assignment, role, and a human/provider-facing revision identifier, but omitted `AttemptId` and candidate content identity. External findings and repair artifacts carried a reference without a content digest, and repairs did not durably identify the findings they addressed.

An identifier alone is not immutable: the same revision or artifact reference can be reused after its content changes. Event-level duplicate detection catches changes only when the same `eventId` is reused; it does not prevent two different events from assigning different content to the same revision or external artifact reference.

Protocol v1 and journal schema v1 have not been published in a GitHub Release or registry package. They are being hardened before their first contract freeze under Issue #44.

## Decision

Update Protocol v1 and journal schema v1 in place. Old frames and journal records without the new required binding fields are rejected. A version bump would imply compatibility with a published v1 contract that does not exist and would preserve a shape known to violate a hard invariant.

Use one closed digest shape at every serialized boundary:

```json
{ "algorithm": "sha256", "hex": "<64 lowercase hexadecimal digits>" }
```

`sha256` is the only v0.1 algorithm. Adding another algorithm is a protocol and journal contract change; decoders do not accept unknown algorithms.

Add the following fields:

| Location | Field | Rule |
|---|---|---|
| `expected` and `signal` | `attemptId` | Required stable identifier |
| `expected` and `signal` | `candidateDigest` | Required typed digest paired with `artifactRevision` |
| `signal` | `evidenceDigest` | Present exactly when `artifactRef` is present; the pair is optional for `review_findings`, required for `repair_submitted`, and forbidden otherwise |
| `expected` and `signal` | `sourceEventId` | Control-plane binding for repair causation. Required for `repair_submitted`, allowed on `blocked` repair attempts, and forbidden on other signal kinds |

The expectation comparison order is fixed as workflow → assignment → attempt → role → candidate revision identifier → candidate digest → source event. Expectation checks remain before duplicate/conflict classification.

For a new event identity, workflow state enforces these durable rules:

- one `artifactRevision` identifies exactly one `candidateDigest`;
- one `artifactRef` identifies exactly one `evidenceDigest`;
- a `repair_submitted` source exists in accepted state, is a `review_findings` event in the same workflow, and has not already been consumed by another accepted repair;
- accepting a repair consumes its source findings event.

An exact retransmission of an already accepted event remains `duplicate`, even after its source was consumed. The event identity check therefore runs before new-event binding and causation checks. Any changed attempt, digest, or source under the same `eventId` is `EVENT_CONFLICT`. Replay enforces the same immutable-reference and causation rules and treats violations as journal corruption.

The DSH adapter receives attempt, candidate digest, and optional repair source from plugin configuration. It injects those values into the protocol request; they do not appear in tool parameters, arguments, or prompt text. The model may supply an external artifact reference and its evidence digest because those describe the artifact produced by the assignment, not the control-plane assignment identity.

## Consequences

### Positive

- Accepted and replayed evidence identifies the exact execution attempt and candidate content.
- Mutable revision and external artifact references fail closed instead of silently rebinding.
- Repair causation is machine-readable, expectation-bound, durable, and single-consumer.
- Event duplicate/conflict semantics automatically include attempt, candidate digest, evidence digest, and causation.
- Rust, TypeScript, JSON Schema, journal runtime, and the DSH adapter share one explicit shape.

### Negative / Risks

- Every producer must know the candidate content digest, and findings/repair producers must know the external artifact digest.
- Existing pre-release state files using the earlier v1 shape cannot be opened and must be discarded or migrated explicitly before use.
- Only SHA-256 is available in v0.1.
- `sourceEventId` creates an ordering dependency: findings must be durable before a repair can be accepted.

### Follow-up

- Add shared positive and negative protocol/journal fixtures for every new required or conditional field.
- Keep adapter tests proving that workflow, assignment, attempt, candidate, event, and causation identity are not model-visible.
- Revisit multi-source repair only through a new evidence/repair-chain ADR; v0.1 consumes one findings event per repair.

## Alternatives considered

- **Version Protocol and journal as v2.** Rejected because no v1 artifact has been released or frozen; preserving the incomplete shape would create compatibility debt without a consumer.
- **Hash only the whole signal.** Rejected because it detects event changes but cannot make a revision identifier or external artifact reference immutable across different events.
- **Let the model supply attempt and candidate identity.** Rejected because assignment identity is fixed by the control plane and must not become prompt-controlled.
- **Infer repair causation from the latest event.** Rejected because ordering is not an explicit causal contract and becomes ambiguous when reviews are parallel.
- **Use a findings-set digest without a source event.** Deferred. An event identity is already durable and gives direct journal traceability; multi-source findings sets require a separate contract.
