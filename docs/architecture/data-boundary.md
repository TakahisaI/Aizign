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
  current DSH adapter exposes `artifactRef` and `shortErrorCode` to the model,
  so v0.1 does not mechanically guarantee that every allowed opaque value is
  free of prohibited content.

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
| Source-qualified classification | Submit server disposition, client outcome, reconciliation disposition, child runtime observation, parent transport observation, and harness-native observation retain separate authorities even when words overlap. Cross-language classification ownership is defined by [`spec/classification/`](../../spec/classification/README.md); its corpus is planned for a later implementation slice. |
| Recognized Protocol error code | A fixed code whose meaning is registered and recognized for the operation; safe for that operation's classification, not a raw provider error body. |
| Model-supplied signal `shortErrorCode` or unrecognized peer code | A bounded diagnostic-shaped string matching `^[A-Z][A-Z0-9_]{0,63}$`. Shape alone provides no semantic provenance or content-safety guarantee. |
| Bounded timestamp | Supplied by the shell. The deterministic core does not read a clock. |

`artifactRef`, `shortErrorCode`, and other allowed opaque fields are not a
covert-content detector. The normal DSH adapter currently lets the untrusted
model choose both strings; a syntactically valid credential-like fragment or
encoded content can therefore reach the protocol and journal without a
malicious adapter. Moving both free-string paths behind trusted configuration,
finite selectors, or equivalent authority is a separate contract change.

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

Journal records use a closed schema. `workflow.commit.json` contains only store
metadata version, committed byte length, entry count, and SHA-256 of the
published prefix. That digest detects a mismatch; it is not candidate identity,
a MAC, a signature, or authentication against a same-user process that can
rewrite both journal and commit metadata.

The prohibited column is a field/shape guarantee. It does not mean the runtime
can recognize credential or raw-content semantics inside every structurally
allowed string. Producers remain obligated by hard invariant 10 not to put
such content there, but end-to-end allowed-value exclusion is not guaranteed in
v0.1 while model-supplied `artifactRef` or `shortErrorCode` remains supported.

Future effect-intent, claim, result, and reconciliation fields are not journal
data today. Adding any such field requires an accepted contract that names the
consumer and owner; Protocol kind/capability; durable record, authority, and
state shape; failure and reconciliation semantics; and tests. This document
does not reserve a field or design the store work in #81.

## Source-qualified classifications

| Source | Current meaning |
|---|---|
| Submit server disposition | The successful `workflow.signal.submit` response says only `accepted` or `duplicate`. A Protocol error response is not a submit disposition. |
| Submit client outcome | A core client reports `accepted`, `duplicate`, `rejected`, or `unknown` after response decoding, correlation, operation-specific code classification, and transport observation. A local pre-transport failure produces no submit outcome. |
| Reconciliation disposition | An exact committed snapshot produces `accepted`, `conflict`, or `absent`. Client inability to establish one of those facts remains `unknown`; it is not a server snapshot disposition. |
| Child runtime observation | The `aizign` child may emit metadata-only operational timing about the handler path. It does not upgrade a wire result or establish what the parent observed. |
| Parent transport observation | A caller may emit metadata-only timing about spawn, response, correlation, and the client outcome. It does not replace the child observation or harness evidence. |
| Harness-native observation | Adapter-specific evidence is classified only under that adapter's documented source, attribution, durability, and retention contract. It cannot override the journal. |

The [classification contract](../../spec/classification/README.md) owns the
target cross-language classification and disclosure rows; its corpus is not
present in this contract-only slice. These terms do not form a universal
outcome service.

## Diagnostics and process environment

| Boundary | Allowed output |
|---|---|
| `aizign` stdout | Exactly one Protocol v1 response frame |
| `aizign` stderr | Normal content-free operational diagnostics. Opt-in child-runtime timing is provisional operational evidence. Until the ordered classification implementation lands, the child keeps its independent mapping and may diverge from this contract; afterward, classification/code disclosure must be driven by the exact rows owned by `spec/classification/`. Neither stage creates a stable public compatibility promise. |
| Human-readable Protocol error message | Operational control-plane diagnostic. Store and OS failures can include the configured state path or platform detail. It is not a model-safe field. |
| DSH model-facing `HarnessError` | Stable code plus a fixed safe message for argument decoding, local Protocol validation, submit rejection, or unknown outcome. Raw argument keys, Protocol messages, and unknown detail are not forwarded; local Protocol errors are not retained as causes. |
| Adapter log | Adapter-owned metadata under its documented policy; native IDs do not cross into the core |
| Adapter/parent timing sink | Closed metadata-only parent transport observations when explicitly configured. Until the ordered classification implementation lands, parent consumers keep their independent mappings and may diverge from this contract; afterward, classification/code disclosure must be driven by the exact rows owned by `spec/classification/`. Timing remains provisional operational evidence, not a stable public compatibility contract. Sink failure is isolated from workflow outcomes; sink retention/access remain caller-owned. |
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
- Adapter-native tests verify stable-identity exclusion from model-visible
  input, any documented result disclosure, and actual native identifiers
  against the complete emitted envelope.
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
