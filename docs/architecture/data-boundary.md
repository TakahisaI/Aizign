# Data boundary

This document is the authority for data that may and may not cross the core,
protocol, journal, adapter, and diagnostic boundaries. The broader trust model,
assumptions, threat classification, and known limitations are defined in
[`docs/security/threat-model.md`](../security/threat-model.md).

## Principles

- Send the core only bounded structured values needed for a decision. Producers
  must not place prompts, screens, natural language, reasoning, model output,
  or credentials in either dedicated fields or allowed opaque values.
- Keep the control journal metadata-only. Content remains in a workspace
  artifact or harness-owned persistence; the journal stores only structured
  references, identity, and digests.
- Keep harness/provider identity inside the adapter. It does not become Aizign
  identity, candidate identity, or process correlation.
- Reserve binary stdout for one Protocol v1 response. Diagnostics use stderr
  and remain content-free.
- A closed schema controls shape, not provenance or string semantics. The
  current DSH adapter exposes `artifactRef` to the model, so v0.1 does not
  mechanically guarantee that every allowed opaque value is free of prohibited
  content.

## Adapter-only data

| Data | Boundary reason |
|---|---|
| Harness session, call, thread, turn, provider, and delivery identifiers | Native identity changes with the harness and is not stable workflow identity. |
| Native tool calls, results, and session events | The adapter maps them to a closed structured signal or auxiliary observation. |
| Raw delivery receipts and provider responses | The adapter maps them to its documented outcome without forwarding the body. |
| Harness persistence records | They are an adapter-specific auxiliary evidence source, not the Aizign journal. |
| Credential location, browser profile, token, and provider environment | The core, protocol, and journal have no credential authority. |
| Prompt, model output, reasoning, and conversation content | Producers must keep them outside the Aizign control plane; v0.1 does not semantically inspect every allowed opaque value. |

## Data allowed across the core boundary

| Data | Contract |
|---|---|
| Stable workflow identity | `workflowId`, `assignmentId`, `attemptId`, `artifactRevision`, and `eventId`; fixed or retained by the trusted control plane/adapter, never model-selected. |
| Candidate digest | SHA-256 computed by the control plane or artifact authority from the intended candidate bytes. The core validates, carries, and compares it; it does not compute or authenticate it. |
| Trusted bounded opaque handle | A length-limited string issued by a trusted boundary. The core compares/stores it but does not interpret external content. |
| Model-supplied bounded metadata | The current DSH tool accepts `artifactRef` and `shortErrorCode` from the model, validates only their closed shape/value constraints, and may persist them in an accepted signal. |
| Structured signal | A closed DTO containing kind and bounded optional metadata such as `findingCount`, `artifactRef`, or `shortErrorCode`. Closed shape does not imply trusted value provenance. |
| Source-qualified disposition | Submit, core reconciliation, and harness-native observations keep separate authorities even when words such as `accepted` or `unknown` overlap. |
| Stable short error code | `^[A-Z][A-Z0-9_]{0,63}$`; safe diagnostic category, not a raw provider error body. |
| Bounded timestamp | Supplied by the shell. The deterministic core does not read a clock. |

`artifactRef` and other allowed opaque fields are not a covert-content detector.
The normal DSH adapter currently lets the untrusted model choose `artifactRef`;
a syntactically valid credential-like token or encoded content can therefore
reach the protocol and journal without a malicious adapter. Moving this value
to trusted configuration or a finite trusted selector is a separate contract
change.

## Capability boundary

| Layer | Boundary |
|---|---|
| Core protocol capability | The binary advertises supported request kinds through `hello.capabilities`. This is protocol compatibility information. |
| Harness adapter capability | Owned by the adapter and its control plane. Protocol v1 has no generic harness-capability field. |
| Workflow requirement | Has no v0.1 runtime representation or consumer. |

Missing harness functionality does not permit raw content or native identity to
cross the protocol boundary, and it does not permit `unknown` to be reclassified.

## Journal data

| Structurally allowed fields | Dedicated fields prohibited by the closed schema |
|---|---|
| Schema/store version and record kind | Raw prompt, model output, or reasoning |
| Stable workflow and candidate identity | Stdout/stderr bodies or native provider responses |
| Signal kind, disposition, and short error code | Environment, credential, secret, or token |
| Digest and bounded opaque handle | Harness/provider/session/call/thread/delivery identity |
| Bounded timestamp and append sequence | Browser profile or credential location |
| Future effect-intent claim identity, only after its own contract exists | Unbounded external payload or artifact bytes |

Journal records use a closed schema. `workflow.commit.json` contains only store
metadata version, committed byte length, entry count, and SHA-256 of the
published prefix. That digest detects a mismatch; it is not candidate identity,
a MAC, a signature, or authentication against a same-user process that can
rewrite both journal and commit metadata.

The prohibited column is a field/shape guarantee. It does not mean the runtime
can recognize credential or raw-content semantics inside every structurally
allowed string. Producers remain obligated by hard invariant 10 not to put
such content there, but end-to-end allowed-value exclusion is not guaranteed in
v0.1 while model-supplied `artifactRef` remains supported.

## Diagnostics and process environment

| Boundary | Allowed output |
|---|---|
| `aizign` stdout | Exactly one Protocol v1 response frame |
| `aizign` stderr | Normal diagnostics: stage, stable identity, kind, disposition, and stable code. Opt-in `aizign_timing:` JSON: allowlisted operation kind, durations/counts, semantic outcome, stable code, and unknown reason without request/event ID, path, or raw content. |
| Human-readable Protocol error message | Operational control-plane diagnostic. Store and OS failures can include the configured state path or platform detail. It is not a model-safe field. |
| DSH model-facing `HarnessError` | Stable code plus a fixed safe message for local input rejection, submit rejection, or unknown outcome. The raw Protocol message/unknown detail is not forwarded and local Protocol errors are not retained as causes. |
| Adapter log | Adapter-owned metadata under its documented policy; native IDs do not cross into the core |
| Adapter/parent timing sink | Closed metadata-only timing values when explicitly configured. Sink failure is isolated from workflow outcomes; sink retention/access remain caller-owned. |
| DSH child environment | `PATH` and explicitly configured client variables only; the parent harness environment is not inherited wholesale |

Operational identity can itself be sensitive metadata. Log retention and sink
access remain operator responsibilities.

## Authority boundaries

- The committed Aizign journal prefix is authoritative for workflow signal
  acceptance.
- Harness persistence is auxiliary and cannot override the journal.
- The control plane is authoritative for assignment identity, state-path
  selection, and candidate-digest provenance.
- Protocol and journal schemas are authoritative for shape and bounds, not for
  the truth of an opaque value.
- Reconciliation observes a committed snapshot and never authorizes retry or
  state repair.

## Verification scope

- Protocol and journal conformance fixtures verify decoder/schema acceptance,
  stable codes, bounds, and closed shapes.
- Core/store tests verify binding, duplicate/conflict, committed-prefix,
  permission, path, locking, corruption, and read-only behavior.
- Adapter-native tests verify model-visible exclusion and compare actual native
  identifiers against the complete emitted envelope.
- `cargo xtask public-audit` checks all tracked paths for forbidden
  names/components. Its fixed known-secret/private-path patterns content-scan
  only tracked UTF-8 text without NUL bytes, excluding the rule-definition
  source. Binary, NUL-containing, non-UTF-8, generated, and untracked contents
  are not scanned.
- Package gates validate documented manifest rules and require
  `cargo package --list` / `npm pack --dry-run` enumeration to succeed. They do
  not evaluate each enumerated file against a repository safety policy or
  secret-scan package artifacts. No gate scans runtime memory, arbitrary logs,
  opaque-field semantics, or all history.
- Live smoke evidence is separate from normal CI and proves only the tested
  integration run.
