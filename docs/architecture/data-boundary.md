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
- Reserve binary stdout for the one response allowed by the
  [canonical process profile](../../spec/process/v1/README.md). Diagnostics use
  stderr and remain payload-free, metadata-only operational data.
- A closed schema controls shape, not provenance or string semantics. The
  supported DSH adapter obtains `artifactRef` and blocked-signal
  `shortErrorCode` from a closed trusted-configuration bundle, but the trusted
  producer remains responsible for their allowed-value semantics.

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
| Model-supplied bounded metadata | The current DSH tool accepts only signal `kind` and optional `findingCount`; it rejects every other model argument before submission. |
| Structured signal | A closed DTO containing kind and bounded optional metadata such as `findingCount`, `artifactRef`, or `shortErrorCode`. Closed shape does not imply trusted value provenance. |
| Source-qualified classification | Submit server disposition, client outcome, reconciliation disposition, child runtime observation, parent transport observation, and harness-native observation retain separate authorities even when words overlap. Cross-language classification rows are owned by [`spec/classification/`](../../spec/classification/README.md) and all production projections are checked against its 78 rows. |
| Recognized Protocol error code | A fixed code whose meaning is registered and recognized for the operation; safe for that operation's classification, not a raw provider error body. |
| Trusted signal `shortErrorCode` or unrecognized peer code | A bounded diagnostic-shaped string matching `^[A-Z][A-Z0-9_]{0,63}$`. Shape alone provides no semantic provenance or content-safety guarantee. |
| Bounded timestamp | Supplied by the shell. The deterministic core does not read a clock. |

`artifactRef`, `shortErrorCode`, and other allowed opaque fields are not a
covert-content detector. The supported DSH adapter prevents the ordinary model
from choosing the two strings, but a trusted producer or a direct Protocol
client can still supply a syntactically valid credential-like fragment or
encoded content.

### Current DSH enforcement

[ADR-0025](../adr/0025-move-dsh-signal-values-behind-trusted-configuration.md)
is implemented by the DSH adapter. Its model-visible arguments are exactly `kind` and
optional `findingCount`; one required closed trusted-configuration bundle owns
the bounded `artifactRef` and blocked-signal `shortErrorCode` values. A single
adapter-internal resolver constructs the exact Protocol payload and the
separate full-binding/full-trusted-bundle mapping key.

The supported-path guarantee does
not cover direct Protocol clients, malicious or compromised adapters or control
planes, existing journal records, harness-owned copies of model input, semantic
secret scanning, or value authenticity. The mapping key is not a Protocol,
journal, timing, model-facing, or harness-evidence field and does not replace
Issue #79's lifecycle key or Issue #80's evidence-removal ownership.

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
such content there. The supported DSH model cannot select `artifactRef` or
`shortErrorCode`, but end-to-end semantic exclusion is not guaranteed for
trusted configured values or direct Protocol clients.

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

The [classification corpus](../../spec/classification/README.md) owns the
cross-language classification and disclosure rows. Production owners retain
only minimal runtime projections checked exhaustively from it. These terms do not form a universal
outcome service.

## Local outbound Protocol boundary

The sole request/response frame encoders defined by
[`spec/protocol/v1/`](../../spec/protocol/v1/README.md#outbound-frame-contract)
validate caller-owned source values and construct a fresh closed wire graph
before any serialization or I/O. Source objects, accessors, prototypes,
symbols, non-enumerable properties, `toJSON`, and JavaScript `Error` runtime
metadata have no direct wire authority.

For a TypeScript error response, the one sanctioned non-plain source is an
authentic non-subclass `ProtocolError`. The encoder revalidates its own data
properties in `code`, then `message` order. Only those two values can cross
into the fresh wire error object. `name`, `stack`, `cause`, custom metadata,
prototype methods, accessors, and source `toJSON` do not cross and are not
invoked to create wire data. A structural lookalike or mutated/forged error is
rejected locally.

An invalid outbound request produces a local `ProtocolError` before parent
timing, process spawn, stdin acquisition, or a transport write. Since no peer
was contacted, this boundary creates no submit/reconciliation outcome,
`reportedCode`, peer `rejected`, or transport `unknown`. An invalid outbound
response fails before the first stdout/transport byte. The canonical process
profile owns the peer's treatment of the resulting no-frame/process fault; the
classification corpus continues to own peer semantic outcomes.

The encoder does not truncate, null, normalize, replace, or infer a fallback.
ADR-0022-owned producers construct any bounded/null-correlation fallback first
and supply the already selected response-version context. The same sole
response encoder either emits that source unchanged as a valid bounded body or
fails before output.

[ADR-0023](../adr/0023-define-protocol-lexical-and-outbound-validation-boundaries.md)
defines this data boundary. Issue #77 S2 implements it across both codecs,
package surfaces, the DSH caller, CLI/fake-core producers, and the shared
conformance evidence.

## Diagnostics and process environment

| Boundary | Allowed output |
|---|---|
| `aizign` stdout | Exactly one bounded response body + LF + close under [CLI process profile v1](../../spec/process/v1/README.md) |
| `aizign` stderr | Payload-free, metadata-only operational diagnostics. Current request ID, registered operation kind, fixed outcome/code, stage, and numeric timing metadata may remain. Request/payload bodies, state or journal contents, prompts, model output, reasoning, credentials, environment contents, and raw peer messages remain prohibited. Stderr has no Protocol, correlation, classification, compatibility, retry, or workflow authority. Opt-in child-runtime timing is provisional operational evidence. Engine use-case stages and JSONL physical stages retain separate owners and are composed by CLI without exposing a path or content. Child classification/code disclosure is exhaustively checked against the exact rows owned by `spec/classification/`. Neither stage creates a stable public compatibility promise. |
| Human-readable Protocol error message | Operational control-plane diagnostic. Store and OS failures can include the configured state path or platform detail. It is not a model-safe field. |
| DSH model-facing `HarnessError` | Stable code plus a fixed safe message for argument decoding, local Protocol validation, submit rejection, or unknown outcome. Raw argument keys, Protocol messages, and unknown detail are not forwarded; local Protocol errors are not retained as causes. |
| Adapter log | Adapter-owned metadata under its documented policy; native IDs do not cross into the core |
| DSH-owned adapter/parent timing sink | Closed metadata-only parent transport observations when explicitly configured through the provisional DSH transport surface. DSH classification/code disclosure is exhaustively checked against the exact rows owned by `spec/classification/`. Timing remains provisional operational evidence, not Protocol or stable public compatibility. Sink failure is isolated from workflow outcomes; sink retention/access remain caller-owned. |
| Adapter child environment | The [harness adapter contract](harness-adapter-contract.md#child-process-environment) owns the language-neutral closed-allowlist rule. DSH passes exactly parent `PATH` when present, otherwise an empty mapping; there are no caller-provided production entries. |

Operational identity can itself be sensitive metadata. Log retention and sink
access remain operator responsibilities.

The current CLI, DSH client, fake core, and benchmark consumers implement the
process-profile wording above. Shared fixture evidence keeps their case IDs
aligned without creating a second authority.

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
