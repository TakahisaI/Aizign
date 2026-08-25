# v0.1 threat model

This document is the normative security and trust-boundary contract for the
unreleased Aizign v0.1 Foundation slice. It describes what Aizign enforces,
what it detects and refuses, what it trusts, what tests demonstrate, and what
it does not guarantee. ADR-0015 records the decision to use this model.

The data allowed to cross component boundaries is defined in
[`data-boundary.md`](../architecture/data-boundary.md). Protocol and durable
format schemas remain authoritative for their wire and storage shapes.

## Scope

The current runtime accepts structured workflow signals through a harness
adapter, a one-shot Protocol v1 process, a deterministic core, and a local
metadata-only JSONL store. It can reconcile an exact signal against a
writer-published committed journal prefix without modifying state.

The threat model does not add cryptographic signing, remote attestation,
multi-tenant isolation, a remote artifact store, credential management,
external-effect execution, automatic retry, or formal verification. A
malicious kernel or root user is out of scope.

## Guarantee vocabulary

| Level | Meaning |
|---|---|
| Runtime enforced | The implementation prevents the unsafe transition or output. |
| Detected and fail closed | The implementation detects the condition and refuses to classify it as a stronger result. |
| Trusted assumption | Correctness depends on the named actor or component behaving as documented. |
| Regression evidence | A test, fixture, audit, or live smoke checks the claim; it is not the enforcement mechanism. |
| Not guaranteed | The property is outside the v0.1 contract or is a known limitation. |

CI evidence is not promoted to a runtime guarantee. A repository-wide claim
must name an enforcement owner and the regression evidence that guards it.

## Trust domains

| Domain | Trusted for | Not trusted for / boundary |
|---|---|---|
| Human operator / control plane | Binary and state-path selection; assignment identity; `eventId` generation or retention; candidate-digest provenance; adapter configuration | A wrong but valid state path is not detected. Configuration still receives shape validation. |
| Model / agent | Nothing across the control boundary | Model-visible arguments are untrusted. In the current DSH tool the model selects signal kind and optional values including `artifactRef` and `shortErrorCode`; accepted opaque values can reach the journal. |
| Harness adapter | Native input mapping; preflight; identity isolation; model-visible schema; correlation and outcome preservation | The core cannot prove that a well-formed signal from a malicious adapter has honest provenance. |
| Harness runtime / provider SDK | Only the native behavior explicitly documented by that adapter | Native IDs and session records are not core identity or workflow-acceptance authority. |
| Remote provider / network | Nothing in the core contract | Availability, confidentiality, ordering, and retention are adapter/provider concerns. |
| `aizign` CLI | One-shot framing, composition, timeout classification, safe diagnostic output | It trusts the configured state path and cannot prove a killed worker made no durable append. |
| Protocol codec | Wire shape, lexical rules, bounds, stable codes, and correlation fields | Schemas do not prove semantic provenance or prevent an allowed opaque string from containing sensitive content. |
| Deterministic core / engine | Value validation, binding comparison, duplicate/conflict decisions, replay, and outcome preservation | The core has no candidate bytes, harness identity, filesystem, clock, or credential authority. |
| JSONL store / local filesystem | Committed-prefix durability on the verified target; strict open, ownership, mode, type, link, lock, and bound checks | Advisory locks and SHA-256 do not stop a malicious same-user process that can ignore locks or rewrite all state files. |
| Harness session persistence | Auxiliary observations under the adapter's documented contract | It cannot override the Aizign journal and has no generic v0.1 durability, retention, or authenticity guarantee. |
| Workspace / artifact authority | Candidate bytes and the digest calculated from them | Candidate storage, retention, and authenticity are outside the core; only the configured digest crosses the boundary. |
| Local OS account and kernel | Process, filesystem, permission, and synchronization semantics used by the verified store | Root/kernel compromise and hostile code with the same account are not isolated by v0.1. |

## Authority and provenance

### Workflow acceptance

The writer-published committed prefix of the Aizign journal is authoritative
for workflow signal acceptance. The core decides whether a signal is new,
duplicate, conflicting, or invalid; the engine reports `accepted` only after
the store has published the event under its durability contract.

Natural-language claims, idle state, screen state, process exit, harness tool
results, and session logs are not workflow-acceptance authority. Harness-native
records can be auxiliary evidence only under the adapter's documented
attribution, integrity, durability, and retention limits.

### Identity

The control plane fixes workflow, assignment, attempt, role, artifact revision,
and candidate digest. It also fixes `eventId`, or the adapter/control plane
generates and retains it for the same logical submission. Stable identity is
never accepted from model-visible input. The current DSH tool discloses the
fixed `eventId` in its successful result, but the model cannot select or alter
it; the other configured identity fields remain outside the input, prompt, and
result. Harness session, call, thread, provider, and delivery IDs do not become
Aizign identity or `requestId`.

The core checks shape and equality in a defined order. It cannot tell whether
a malicious adapter copied values from the intended control-plane source. That
provenance is a trusted adapter/control-plane assumption.

### Digests

The three current digest roles are independent:

| Digest | Producer / authority | What comparison establishes | What it does not establish |
|---|---|---|---|
| Protocol `candidateDigest` | Control plane or artifact authority that can read candidate bytes | Expected, submitted, and accepted event content carry the same typed digest | Candidate authenticity when the producer or configured value is untrusted |
| Store committed-prefix SHA-256 | JSONL writer | Commit metadata matches the exact prefix read by the store | Authentication against a same-user attacker that rewrites journal and metadata together |
| DSH `bindingDigest` / `payloadDigest` | DSH adapter | Adapter-specific correlation or recorded payload observation as documented by that adapter | Protocol candidate identity, remote attestation, or generic harness evidence |

No current digest is a MAC or signature. There is no algorithm negotiation in
store metadata v1.

### Reconciliation

Core reconciliation reads only an existing complete committed snapshot and
compares the exact full signal. It is independent of harness persistence and
does not initialize, append, synchronize, repair, truncate, publish a tail, or
retry. `absent` is a snapshot observation and does not authorize resubmission.

Missing artifacts, active writer lock, corruption, bounds failure, unpublished
tail, unsupported platform, transport failure, timeout, or correlation failure
remain `unknown`. A wrong but valid initialized state directory is not
detectable because v0.1 has no durable state-instance identity.

## Inputs by trust level

Treat these as untrusted and validate before use:

- model-visible tool arguments, including the current DSH `artifactRef` and
  `shortErrorCode` strings;
- every Protocol v1 byte frame, including output from a spawned binary;
- every journal and commit-metadata byte read after open;
- every harness/provider event used for auxiliary evidence; and
- all correlation identifiers returned across a process boundary.

Treat these as trusted assumptions after local shape validation:

- configured binary and state-directory selection;
- configured workflow/assignment/attempt/candidate identity;
- the artifact authority's candidate-digest calculation;
- the adapter implementation that maps native input and withholds identity;
- the local account and kernel; and
- provider or harness guarantees explicitly claimed by an adapter.

Shape validation does not turn a model-supplied opaque value into trusted
metadata. In particular, the current DSH `artifactRef` and `shortErrorCode`
accept bounded strings from the model and do not scan those values for
credentials, prompts, encoded content, or other sensitive material. Such a
value can be persisted in the control journal if the signal is accepted.

## Threat and failure matrix

The guarantee-level column uses only the five values defined above. Where a
threat crosses layers, the row uses the weakest end-to-end level.

| Threat or failure | Guarantee level | Enforcement owner | Runtime response | Regression evidence | Residual limitation |
|---|---|---|---|---|---|
| Malformed UTF-8, BOM, duplicate member, invalid Unicode, non-canonical number, unknown field or kind | Runtime enforced | Rust and TypeScript protocol codecs | Reject with a stable code before domain handling | Shared protocol and schema conformance fixtures | A valid opaque field can still carry semantically inappropriate content |
| Oversized request or response | Detected and fail closed | Production encoders, CLI, and clients | Refuse outbound frames or reject inbound frames before a stronger classification | Encoder bounds, CLI framing, and core-client conformance tests | Timeout bounds caller wait, not all remote work |
| Multiple or injected stdout frames | Detected and fail closed | CLI and core clients | Reserve stdout for one response and classify extra data as `unknown` | CLI tests and core-client fault scenarios | A third-party transport is not authorized by v0.1 |
| Response `requestId`, kind, or event mismatch | Detected and fail closed | Core clients | Return `unknown`; retain a valid reported code only as diagnostic data | Core-client correlation scenarios | The caller still cannot determine whether an append happened |
| Model controls stable identity or candidate digest | Runtime enforced | Current DSH adapter | Closed input schema omits stable identity; validated configuration is injected | DSH input-schema, config, mapping, and captured-envelope tests | The successful DSH result discloses the fixed `eventId`; non-selection is enforced, not identity confidentiality, and a malicious adapter can still submit a well-formed false value |
| Harness/provider identity leaks into core identity or envelope | Runtime enforced | Current DSH adapter mapping | Use an adapter nonce and construct the envelope without native IDs | DSH captured-envelope round-trip tests | Generic key scanning cannot prove value provenance; each adapter owns native-value tests |
| Model-supplied opaque value contains a prompt, output, credential, token, or encoded content | Not guaranteed | No semantic value scanner in v0.1 | A syntactically valid `artifactRef` or `shortErrorCode` can be accepted and journaled | Tests prove only closed shape and known native-ID exclusion | Current DSH exposes both strings to the model; Issue #72 must close both free-string paths before any stronger end-to-end allowed-value claim |
| A dedicated raw-content, environment, credential, or native-ID field is added to protocol/journal | Runtime enforced | Closed protocol and journal schemas/DTOs | Reject unknown fields; owned encoders do not define such fields | Protocol/journal fixtures and schema tests | This is structural exclusion only and does not inspect allowed string values |
| Parent harness credential environment leaks to `aizign` | Runtime enforced | DSH one-shot client | Rebuild child environment from `PATH` and explicit client variables | DSH synthetic parent-credential inheritance test | Explicitly configured child variables are trusted caller responsibility; no credential manager exists |
| Expected and signal binding disagree | Runtime enforced | Deterministic core | Compare workflow, assignment, attempt, role, revision, then candidate digest before duplicate/conflict | Core mismatch-order, protocol, and replay tests | This compares the two submitted values; it does not establish which external assignment or candidate is current |
| Control plane supplies a stale but internally consistent assignment/candidate binding | Trusted assumption | Operator/control plane | The core accepts a well-formed pair when `expected` and `signal` agree | Conformance scenarios demonstrate that an internally consistent alternative candidate can be accepted | No current-assignment registry or artifact-authority lookup exists in v0.1 |
| Partial write, barrier failure, corrupt or unpublished tail | Detected and fail closed | JSONL store | Publish only after barriers; keep uncertain writes as `OutcomeUnknown`; read only the exact committed prefix | Store fault-injection, tail, corruption, digest, count, and reopen tests | A same-user attacker can forge all mutually consistent files |
| Lock failure or concurrent writer | Detected and fail closed | JSONL store | Reject lock contention rather than observe or write concurrently | Store lock tests | A malicious same-user process can ignore advisory locks |
| Symlink, special file, hard link, wrong owner or mode | Detected and fail closed | JSONL store | Reject the unsafe artifact/path before use | Store path, permission, symlink, special-file, and hard-link tests | State-path choice and the same OS account remain trusted |
| Wrong but valid state directory | Trusted assumption | Operator/control plane | Use the configured initialized store | No runtime proof in v0.1 | No state-instance manifest exists |
| Same-user state modification | Not guaranteed | No separate same-user security boundary | Detect only incomplete/inconsistent rewrites | Corruption and mismatch tests cover accidental/incomplete changes | No MAC, signature, privilege separation, or attestation |
| Missing, reordered, forged, or expired harness persistence | Not guaranteed | Adapter-specific evidence reader | DSH returns unknown/throws for detected missing or unverified observations | DSH cold-read tests | Matching forged metadata, real persistence durability/retention, and source-side bounds are not established |
| Timeout, abort, response loss, or `JOURNAL_OUTCOME_UNKNOWN` | Detected and fail closed | Engine and core clients | Preserve `unknown` and do not retry blindly | Engine lost-ack tests and core-client fault scenarios | Read-only reconciliation cannot resolve missing/corrupt/unpublished state |
| Reconciliation returns `absent` | Runtime enforced | Core-client orchestration | Return the observation without implicit submit | Core-client absent/no-submit and store read-only tests | A later writer can make the observation stale after lock release |
| Protocol or local-validation diagnostic detail reaches the model-facing DSH tool error | Runtime enforced | DSH input/outcome mapping | Preserve the stable code but replace local-validation, rejected, and unknown diagnostic text with fixed safe messages; do not retain the local Protocol error as a cause | DSH tool mapping tests cover synthetic private-path peer detail and invalid local input without cause-chain recovery | Direct trusted `CoreClient` consumers still receive operational Protocol messages and must apply their own presentation policy |
| CLI diagnostic output contains a raw request/content body | Runtime enforced | CLI diagnostic mapping | Emit bounded stage, identity, kind, outcome, and stable code only | CLI stderr-content test | Identity metadata itself may be sensitive; external log sinks are operator-owned |
| Opt-in timing leaks request/event identity or content, or a timing sink changes the workflow result | Runtime enforced | CLI/engine observation mapping and TypeScript/DSH timing helpers | Emit only allowlisted operation/timing/count/outcome/code fields and isolate synchronous/asynchronous sink failure | CLI timing tests, engine observation tests, TypeScript/DSH timing tests, and benchmark artifact allowlist tests | Durations, counts, operation kind, and outcome remain operational metadata; external sink retention/access are caller-owned |
| Tracked path violates the forbidden name/component policy, or an eligible text file contains a fixed known secret/private-path pattern | Regression evidence | `cargo xtask public-audit` | Check every tracked path; content-scan tracked UTF-8 text without NUL except the rule-definition source | `xtask` audit unit tests and the repository gate | Binary, NUL-containing, non-UTF-8, exempt-source, runtime, untracked/generated, package-artifact, opaque-value, and full-history content is not scanned |
| Package manifest violates the checked policy, or a package manager cannot enumerate a packable file set | Regression evidence | Manifest audit, `cargo package --list`, and `npm pack --dry-run` gates | Reject checked manifest rules or a failed package enumeration command | Package/public-audit gates | The enumerated file list is not evaluated against a repository safety policy and package artifact contents are not secret-scanned |
| Old binary opens current state directory | Not guaranteed | Operator procedure | Documentation requires a separate state directory | Compatibility and store contract documentation | No downgrade fence; an old binary may ignore commit metadata |
| Unsupported platform receives a weaker durability contract | Runtime enforced | Store target gate and CLI capability handling | Omit store capabilities and reject direct requests | Supported-target and x32 compile-time negative tests | Only `x86_64-unknown-linux-gnu` is currently supported for the store |

### Regression evidence index

The matrix names test families rather than treating a test as an enforcement
mechanism. Their repository locations are:

| Evidence | Primary location |
|---|---|
| Rust protocol closed decoding, shared fixtures, examples, and encoder bounds | `crates/aizign-protocol/tests/closed_decoder.rs`, `conformance.rs`, and `examples.rs` |
| TypeScript protocol lexical, envelope, fixture, mapping, and bound checks | `packages/protocol/src/*test.ts` |
| Schema and cross-language fixture inventory | `spec/conformance/`, `spec/test/schema.test.mjs`, and `cargo xtask conformance` |
| Core binding order, duplicate/conflict, and pure reconciliation | `crates/aizign-core/tests/workflow_signal.rs` and `workflow_recovery.rs` |
| Unknown preservation, lost acknowledgement, and reconciliation mapping | `crates/aizign-engine/tests/handle_workflow_signal.rs` and `reconcile_workflow_signal.rs` |
| Store barriers, commit publication, corruption, tail, bounds, locks, permissions, path shape, and read-only behavior | `crates/aizign-store-jsonl/tests/jsonl_journal.rs` plus store unit fault injection |
| CLI framing, timeout, stderr, capability, and unsupported-target behavior | `crates/aizign-cli/tests/handle.rs` |
| Metadata-only timing shape and observer-failure isolation | `crates/aizign-engine/tests/observation.rs`, CLI/TypeScript/DSH timing tests, and `benchmarks/performance/run.test.mjs` |
| TypeScript one-shot faults, correlation, no-retry, no-submit-after-absent, and no-spawn-on-oversize | `packages/adapter-testkit/src/conformance.ts` and `reference-client.test.ts` |
| DSH config/tool schema, native identity exclusion, environment isolation, diagnostic normalization, preflight, round trip, and cold read | `adapters/dsh/test/unit/` and `adapters/dsh/test/conformance/` |
| Tracked-path policy and eligible UTF-8-text fixed-pattern scan | `xtask/src/audit/secrets.rs` through `cargo xtask public-audit` |
| Package manifest policy and packable-file-set enumeration | `xtask/src/audit/packages.rs`, `cargo package --list`, and `npm pack --dry-run` |

The opt-in DSH live smoke is not part of normal CI and is not evidence for
general provider, network, or persistence guarantees.

## Hard-invariant traceability

| Invariant | Current enforcement owner | Regression evidence / status |
|---|---|---|
| 1. Natural language, idle, and UI are not completion authority | Core accepts only structured commands/events; journal is authoritative | Core workflow tests, closed protocol/journal schemas, adapter mapping tests |
| 2. Claim before external effect | Architectural invariant; no external-effect runtime exists in v0.1 | Not claimed as implemented until an effect slice adds runtime tests |
| 3. Do not blindly retry an unknown effect | Engine/client preserve `OutcomeUnknown`; current submission path does not retry | Lost-ack and client fault tests |
| 4. Do not guess `unknown` as success/failure | Engine, protocol clients, adapter mapping | Engine and adapter-testkit unknown scenarios |
| 5. Bind evidence to workflow, assignment, attempt, and candidate | Core validation and accepted event content | Core mismatch-order, protocol, journal, replay tests |
| 6. Review pass alone does not integrate | Repository/workflow policy; no integration runtime exists in v0.1 | Not a current runtime guarantee |
| 7. Human authorization is revision-bound and append-only | Future authorization context; not implemented in v0.1 | Not claimed as implemented |
| 8. Provider identity is not core identity | Adapter mapping and provider-neutral core/protocol/journal types | Dependency/public audit and DSH captured-envelope tests |
| 9. Restart reconciliation is bounded and read-only | Store reader, engine port separation, CLI composition | Store read-only/bounds tests and reconciliation tests |
| 10. Journal is metadata-only and producers do not place raw content/credentials in allowed values | Closed DTOs prohibit dedicated raw-content fields; producer mapping owns allowed-value semantics | Shape exclusion is tested. End-to-end value-content exclusion is not guaranteed while DSH accepts model-supplied `artifactRef` or `shortErrorCode` |
| 11. No automatic remote publication or force update | No such runtime operation exists in v0.1 | Not claimed beyond absence and repository policy |
| 12. Same identity/content is duplicate; changed content is conflict | Deterministic core | Core decision, replay, engine, and client scenarios |

## Platform and release limits

- The committed-prefix store is supported only on
  `x86_64-unknown-linux-gnu`. x32 is intentionally unsupported and exists only
  as a compile-time negative boundary.
- `0.x` supports only the latest minor release.
- Opening the same state directory with an older binary is unsupported and not
  technically prevented.
- Normal CI uses fakes and the local binary. A separately reported live smoke
  can demonstrate one harness/provider integration, but it does not establish
  general provider availability, confidentiality, retention, or security.
- A vulnerability report must use GitHub private vulnerability reporting and
  must replace real credentials, paths, prompts, and model output with
  synthetic values.

## Change control

A new transport, supported platform, adapter authority, credential flow,
external effect, automatic retry, remote store, signing mechanism, or
multi-tenant process changes this model. Open a proposal-first Issue and add or
supersede an ADR when the trust or security boundary changes. Update this
document, the data boundary, relevant package documentation, and regression
evidence in the same PR.
