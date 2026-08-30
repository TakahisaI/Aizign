# Harness adapter contract

This document is the normative, language-neutral contract for an Aizign
harness adapter. It defines observable behavior and ownership boundaries, not a
package layout, programming language, harness event format, or shared adapter
runtime.

The authorities are deliberately separate:

| Concern | Authority |
|---|---|
| Harness adapter behavior and capability boundaries | This document |
| Adapter/core process argv, framing, lifecycle, bootstrap selection, and process faults | [`spec/process/v1/`](../../spec/process/v1/README.md) |
| Core--adapter wire format, schemas, kinds, and stable codes | [`spec/protocol/v1/`](../../spec/protocol/v1/README.md) |
| Decoder acceptance and full-codec round-trip fixtures | [`spec/conformance/`](../../spec/conformance/README.md) |
| Language-neutral directional encoder scenarios | [`spec/conformance/encoder-scenarios.md`](../../spec/conformance/encoder-scenarios.md) |
| Cross-language classification ownership and timing-disclosure rows for current operations | [`spec/classification/`](../../spec/classification/README.md) |
| Harness-native behavior | The adapter's README, source, and native tests |
| TypeScript convenience APIs and runner behavior | [`packages/protocol/`](../../packages/protocol/README.md) and [`packages/adapter-testkit/`](../../packages/adapter-testkit/README.md) |

The [adapter implementation guide](../development/adding-adapter.md) explains
how to apply this contract. It is not a second behavioral authority.

## Capability layers

Keep these three layers separate. A token or field in one layer does not
silently acquire meaning in another.

| Layer | Authority and use | v0.1 representation |
|---|---|---|
| Core protocol capability | An operation understood by the Aizign binary | Request kinds advertised by `hello.capabilities` |
| Harness adapter capability | An operation or evidence source an adapter can safely execute and verify on its harness | Adapter documentation and harness-native tests; no universal runtime manifest or Protocol v1 field |
| Workflow requirement | A capability required by a particular workflow | Provisional; no v0.1 consumer, negotiation field, or dispatch runtime |

`hello.capabilities` reports core protocol operations. It is not a manifest of
DSH or another harness's features.

## Current minimum

A v0.1 signal-submission adapter must:

1. perform protocol health, version, and capability checks before exposing its
   submission path;
2. submit a scope-bound structured workflow signal;
3. obtain workflow, assignment, attempt, role, artifact revision, and candidate
   digest from trusted control-plane configuration;
4. obtain `eventId` from trusted control-plane configuration, or have the
   adapter/control plane generate it and retain it for the same logical
   submission;
5. keep `eventId` and all other stable identity fields out of model-visible
   arguments;
6. keep harness session, call, thread, provider, and delivery identifiers out
   of Aizign identity and the complete protocol envelope, including
   `requestId`;
7. validate response `requestId`, `kind`, and, where applicable, `eventId`
   correlation;
8. preserve the submit client outcome as `accepted`, `duplicate`, `rejected`,
   or `unknown`, without presenting a client-derived result as a server
   disposition;
9. never infer success, rejection, or absence from `unknown`, and never blindly
   retry an unknown submission;
10. use the closed protocol field set, add no dedicated raw-content or
   credential field, and require producers not to place prompts, model output,
   reasoning, credentials, or encoded content in allowed opaque values. Closed
   shape is enforced; each adapter must document and test which trusted
   boundary owns every opaque value, while end-to-end value semantics remain
   the producer's responsibility;
11. treat human-readable protocol diagnostics as operational data, not as
   model-safe text, and normalize them before a model-visible error boundary;
   and
12. enforce request and response frame limits, reject extra response frames,
    and place a wall-clock bound on caller wait. If cancellation cannot prove
    that remote work stopped, the outcome remains `unknown`.

An adapter need not persist outcomes, expose harness-native evidence, implement
core reconciliation, or provide lifecycle operations to satisfy this minimum.
Optional capabilities do not weaken any minimum requirement.

## Protocol and transport

The accepted adapter transport is the one-shot boundary selected by
[ADR-0003](../adr/0003-use-a-versioned-ndjson-process-boundary.md) and closed by
[ADR-0022](../adr/0022-define-the-canonical-one-shot-process-profile.md).
[`CLI process profile v1`](../../spec/process/v1/README.md) owns the exact
`handle --state <dir>` argv, one body + LF + EOF request, response close/exit,
watchdog stages, bootstrap selection, and process-fault behavior. Protocol v1
owns the JSON body schemas, bounds, kinds, capabilities, and stable codes.

Production preflight sends a framed correlated hello through the same canonical
`handle` path as submit and reconcile. It decodes bootstrap v1, correlates
request ID and kind, compares the advertised operation version, and then checks
required capabilities. It sends no operation on incompatibility or `unknown`.
Direct `aizign hello` is provisional operator diagnostics only and is not an
interchangeable adapter contract.

The current CLI, DSH, fake-core, and benchmark consumers implement process
profile v1. A future transport accepted by an ADR may
be added only if it preserves the applicable Protocol envelope, closed
decoding, process/frame bounds, correlation, and outcome semantics. MCP, a
harness SDK, or a provider API is not the Aizign wire authority.

Each request uses an adapter-owned nonce for `requestId`. Native harness
identifiers must not be repurposed as correlation or workflow identity.

## Child process environment

Every process-spawning adapter constructs the child environment from an empty
mapping plus a closed, documented allowlist. It must not copy the parent
environment wholesale or expose an open production environment mapping.

The allowlist excludes credentials and tokens; provider, harness, session,
call, thread, turn, and delivery identity; HOME and XDG/config/cache locations;
parent diagnostics and tracing/exporter controls; unrelated locale/runtime
configuration; unrelated `AIZIGN_*` variables; and all fake/fault-injection
controls. A future process-profile variable requires an accepted contract that
names the variable and owner.

An adapter may copy PATH only when its documented launch path needs interpreter
lookup for the already configured executable. This does not authorize relative
paths, cwd behavior, executable discovery, shell invocation, or arbitrary
interpreter configuration. Repository tests and benchmarks may use generated
non-production executable wrappers to inject controls after the adapter-owned
launch boundary.

Each adapter claiming process-spawn conformance owns a native test that
captures the complete environment received at that launch boundary and
compares its exact keys and values with the documented allowlist. Denylist
assertions or a fake client alone are insufficient.

The current DSH projection is exactly parent PATH when it exists, otherwise an
empty mapping. Its native evidence owns these stable scenarios:

| ID | Required evidence |
|---|---|
| `adapter-env-path-present-exact` | Complete child environment is exactly the parent PATH key/value |
| `adapter-env-path-absent-empty` | Parent PATH absent produces exactly `{}`; no empty PATH is synthesized |
| `adapter-env-sensitive-parent-excluded` | Credential, provider/session/call, HOME/XDG, diagnostic, unrelated `AIZIGN_*`, and fake controls are absent from the complete capture |

## Capability absence

`CAPABILITY_UNSUPPORTED` is a core Protocol response only. It means the binary
decoded a Protocol-registered operation request under an accepted operation
version but the current binary/build/target does not provide that operation.
It is not synthesized from successful hello data and does not represent
harness-native availability.

The three absence sources remain distinct:

| ID | Source-qualified result |
|---|---|
| `adapter-submit-capability-missing` | Correlated hello lacks required submit; parent compatibility fails, DSH returns `AIZIGN_INCOMPATIBLE`, no submit is sent, and no Protocol code is synthesized |
| `adapter-reconcile-capability-missing` | Submit is usable; caller-local `checkCompatibility` observes missing reconciliation and sends no reconcile request; no code/outcome/API is added |
| `adapter-native-integration-absent` | Adapter-native feature is unavailable or not exposed; Protocol preflight, submit, reconciliation, and classification are unchanged |

For a successful correlated hello whose operation version is incompatible or
whose required submit capability is missing, DSH parent timing contains exactly
`operation_kind: preflight`, `outcome: rejected`, no `error_code`, and no
`unknown_reason`. An actual decoded peer error remains subject to the existing
fixed-code disclosure rule.

## Source-qualified classifications

Similar words from different sources do not carry the same authority.

| Source | Vocabulary | Meaning |
|---|---|---|
| Submit server disposition | `accepted`, `duplicate` | Success payload returned by `workflow.signal.submit`; an error response is not a disposition |
| Submit client outcome | `accepted`, `duplicate`, `rejected`, `unknown` | Result produced by a client after response, code, correlation, and transport classification |
| Reconciliation disposition | `accepted`, `conflict`, `absent` | Server classification of the exact complete signal against a decoded committed snapshot |
| Reconciliation client observation | the disposition above, or `unknown` | What the client can establish after response and transport checks; `unknown` is not a snapshot disposition |
| Child runtime observation | Current metadata-only handler timing vocabulary | What the `aizign` child observed while handling an operation; provisional operational evidence only |
| Parent transport observation | Current metadata-only spawn/response/client timing vocabulary | What the caller observed across the process boundary; provisional operational evidence only |
| Harness-native observation | Adapter-specific | Classification of native records under that adapter's documented evidence contract |

Submit client outcomes have these meanings:

- `accepted`: the core reports that the exact signal was accepted and durably
  recorded under the journal contract;
- `duplicate`: the same `eventId` and exact accepted event content already
  exist, so no second event is appended;
- `rejected`: the core definitively refused this request and returned a stable
  rejection code recognized for this operation; and
- `unknown`: the client cannot establish whether this request took effect.

The Protocol error-code syntax is open. The current operation/code mappings are
owned by the [classification corpus](../../spec/classification/README.md), not
by a duplicated table in this document. Production projections are checked
against all 78 rows. A submit client may return `rejected`
only for its closed allowlist of codes whose operation semantics establish a
definitive refusal. It must preserve any well-formed but unrecognized code as
diagnostic `reportedCode`, classify the submit as `unknown`, and never retry it
implicitly. Reconciliation clients classify every error response as `unknown`.

Child runtime timing, parent transport timing, and harness-native evidence are
separate observations; none can be substituted for another or used to upgrade
a server disposition or client outcome. Timing is provisional operational
evidence, not a stable public compatibility contract. This vocabulary split
does not create a universal classification or outcome service.

`unknown` is terminal knowledge about the observation, not permission to retry.
A caller may perform a separately defined read-only reconciliation or another
safe observation, but must not collapse the original result.

An operation can also fail before producing an outcome value. Unless an
adapter explicitly defines a closed outcome for that failure, callers must
treat the observation as unavailable and must not infer success, rejection, or
absence from the thrown error.

Outbound validation or encoding failure before any process or transport starts
is a distinct local failure. It produces no submit classification: the core did
not return `rejected`, and the not-started transport is not `unknown`. The
language binding documents whether its API throws/rejects or returns a local
failure value. The harness adapter maps that failure through its native error
boundary without claiming a core decision.

## Core reconciliation

`workflow.signal.reconcile` is a core protocol capability over the Aizign
control journal. It is independent of harness persistence and is not a
harness-evidence mode.

A client claiming reconciliation support must:

- query with the same complete `WorkflowSignal`, including optional fields;
- check that the binary advertises the reconciliation capability;
- preserve `accepted`, `conflict`, `absent`, and `unknown` without collapsing
  them;
- retain a syntactically valid reported stable code as diagnostic information
  before applying correlation checks, without treating an uncorrelated code as
  a fact about the request;
- treat `absent` only as an observation of the completed snapshot, never as
  permission for automatic or implicit resubmission; and
- make no append, initialization, synchronization, repair, or tail-promotion
  request as part of reconciliation.

Only an existing, completely decoded, committed snapshot can produce
`accepted`, `conflict`, or `absent`. Missing or inconsistent storage, an active
writer, corruption, an unpublished tail, transport failure, timeout, and
correlation failure remain `unknown`. The detailed storage guarantee is owned
by [ADR-0013](../adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md)
and the store specification.

Submission must not become unavailable merely because reconciliation is
unavailable. Any retry policy after `absent` requires a separately defined
decision and authorization boundary.

### Accepted DSH lifecycle target (not yet implemented)

ADR-0029 accepts a future DSH-owned logical-submission lifecycle whose sole
normative authority is [`spec/dsh/lifecycle/v1/`](../../spec/dsh/lifecycle/v1/README.md).
It will durably fence a submit before child spawn, retain the exact trusted
signal, recover uncertain attempts as reconciliation-required, and expose a
control-plane-only reconciliation service. Submit and reconcile will share one
non-waiting process-local gate; `absent` will never authorize resubmission.

This target does not change the current Protocol operations, classification
rows, process profile, core journal, or store. The current DSH adapter has no
lifecycle root, initializer, owner lease, durable event record, lifecycle
service, or `./experimental/lifecycle` subpath. Those remain an atomic S2
migration debt and must not be inferred from this accepted contract.

## Completion authority and harness evidence

The Aizign control journal is authoritative for workflow signal acceptance.
Natural-language claims, idle state, UI state, and process exit alone are not
completion evidence.

Durability and attribution are independent properties of harness-native
evidence. An adapter may rely on a native record only when:

1. the source has a documented durability and retention contract; and
2. the adapter verifies attribution to the requested binding and, if it claims
   payload integrity, to the requested payload.

A durable-looking error without verifiable binding metadata is not proof that
the requested binding was rejected. Conversely, binding verification does not
prove crash durability or retention. The adapter owns its native evidence
interpretation and must document its limits.

No current v0.1 DSH supported path claims harness persistence or cold read.
The conditional rules above remain a guard for a future adapter that obtains a
separately accepted native-evidence contract; they do not reserve an API or
require an empty evidence layer.

## Data boundary

Adapters may send only the closed field set of stable identity, bounded opaque
handles, digests, structured evidence, dispositions, and stable short error
codes across the core boundary. Producers must not place raw conversation data
or credentials in those fields. This is an obligation and a structural field
exclusion, not a claim that every allowed string is semantically inspected.

A recognized stable error code is safe to classify according to the
operation-specific registry. A well-formed but unrecognized code is diagnostic
data, not a rejection fact. A human-readable Protocol error message is also
operational diagnostic data and can contain a configured state path or
operating-system detail. An adapter must not forward either an unrecognized
peer code or that message to a model-visible error surface; for an unknown
submit it uses a fixed adapter-owned code and safe message.

The adapter maps native inputs to protocol DTOs but does not expose core or
engine internal types to its harness. The core, protocol, and journal likewise
must not acquire harness or provider names. See
[data-boundary.md](data-boundary.md) for the complete repository boundary.

Adapter configuration and native mapping form a trust boundary. The core can
reject malformed values and inconsistent bindings, but it cannot prove that a
well-formed identity or digest came from the intended control-plane source. A
malicious adapter can also place prohibited content into an otherwise allowed
opaque field. The v0.1 assumptions, enforcement limits, and regression-evidence
requirements are defined in the
[threat model](../security/threat-model.md).

## Conformance ownership

Conformance has three independent parts.

### Wire conformance

Every implementation must match the Protocol v1 envelope rules and schemas for
the directions and kinds it uses:

- a client adapter applies
  [the encoder scenarios](../../spec/conformance/encoder-scenarios.md) to each
  request kind it sends and the decoder fixtures to each response kind it
  receives;
- an adapter claiming the reconciliation extension also applies the
  reconciliation request-encoder scenario and response-decoder fixtures; and
- a language binding claiming a full Protocol v1 codec applies every decoder
  fixture, full-codec round trip, and request/response encoder scenario.

`spec/conformance/` contains the language-neutral valid and invalid frames.
Those files remain decoder acceptance fixtures; they are not request-encoder
inputs. A submission-only client need not implement a server-side request
decoder, response encoder, or unclaimed kind. Each language may provide its own
runner over the applicable fixtures and encoder scenarios.

### Core-client conformance

The language-neutral scenario requirements are grouped by claimed behavior.

The minimum signal-submission group covers:

- compatible `hello` and the submit capability;
- valid encode/decode and a single bounded response frame;
- `accepted`, then `duplicate`, then conflicting content;
- expectation mismatch and stable rejection codes;
- timeout, no response, malformed or oversized response, spawn/transport
  failure, and correlation mismatch becoming `unknown`;
- oversized outbound requests failing locally before any process/transport,
  with no submit classification and no emitted frame;
- non-collapse of `unknown` and no blind submit retry; and
- closed protocol frames with no harness or provider identifier leakage,
  together with tests for the producer's claimed allowed-value semantics; and
- model-visible errors that retain the stable code without forwarding raw
  Protocol diagnostic text.

The reconciliation extension group covers:

- capability checking;
- exact-signal `accepted`, changed-content `conflict`, and committed-snapshot
  `absent`;
- unavailable/corrupt/inconsistent storage and transport failures remaining
  `unknown`;
- diagnostic `reportedCode` handling around correlation failure; and
- proof that the reconciliation path does not modify state or submit after
  `absent`.

Scenario requirements are shared; an executable runner is not. A language may
express them with its native test framework. This repository does not define a
stdin/stdout adapter-test protocol or a universal adapter driver.

### Harness-native adapter conformance

Each adapter owns tests for:

- its native entrypoint or registration surface, where applicable;
- native input to protocol DTO mapping;
- the model-visible schema when a model-visible surface exists;
- trusted identity injection, including `eventId` generation/retention and the
  exclusion of stable identity from model-visible input;
- exclusion of native session, call, thread, provider, and delivery identities
  from the complete protocol envelope;
- protocol health/capability preflight before the submission path is exposed;
  and
- harness failures mapped to the adapter's documented outcome or failure
  boundary.

When an adapter claims persistence/cold read, native session or call identity
handling, lifecycle hooks, or native evidence semantics, it additionally owns
tests for those claims, including durability, retention, attribution,
integrity, bounds, and cancellation limits as applicable. An adapter without
such a claim does not create an empty layer or no-op test.

Those tests may reuse shared assertions, but no common executable harness
interface is required.

### Requirement and test ownership

Passing one test layer does not prove requirements owned by another:

| Requirement | Primary test owner |
|---|---|
| Protocol envelope, schema, stable code, and applicable encode/decode acceptance | Language codec tests over applicable `spec/conformance/` fixtures |
| Local request-size failure before process/transport; response/frame bounds, correlation, and submit outcome mapping | Protocol encoder and core-client tests, as applicable |
| Negative preflight for incompatible version or missing submit capability before exposing submission | Harness-native adapter tests, using a fake core/client |
| `eventId` and other stable identity provenance; model-visible input exclusion and any documented result disclosure | Harness-native adapter tests |
| Harness/provider identity exclusion from the complete emitted envelope | Harness-native adapter tests that inspect captured requests |
| Duplicate/conflict and durable journal semantics | Core, engine, store, and protocol tests |
| Reconciliation mapping and diagnostic code handling | Core-client tests plus core/store tests |
| No state mutation and no resubmission after reconciliation `absent` | Core/store tests for read-only behavior; harness-native adapter tests for orchestration behavior |
| Claimed persistence, lifecycle, durability, retention, or evidence semantics | Harness-native tests, only when claimed |

## TypeScript convenience layer

`@aizign/protocol` is the TypeScript codec, types, compatibility helpers, and a
Node-free abstract `CoreClient` interface. `@aizign/adapter-testkit` provides a
fake core, scripted faults, convenience assertions, and a TypeScript
conformance runner applied to a supplied production client. It does not provide
a client implementation. The current DSH adapter owns the only production
TypeScript one-shot transport.

The current TypeScript `CoreClient` and `runCoreClientConformance` expose and
exercise both submit and reconciliation operations. They are a TypeScript
convenience core-client interface and scenario runner, not a proof of the whole
harness adapter contract. Implementing the interface or passing the runner does
not establish trusted identity provenance, model-visible input isolation or
result-disclosure policy, native registration/preflight behavior, or
harness-evidence conformance. Failing to
implement that TypeScript interface does not by itself make a non-TypeScript
submission adapter non-conforming.

In this TypeScript reference API, an outbound request above
`MAX_REQUEST_BYTES` rejects the client Promise with
`ProtocolError(REQUEST_TOO_LARGE)` before spawn and produces no
`SubmitOutcome`. The runner verifies both that the fake-core process is not
started and that it receives no request.

TypeScript adapters in this repository follow the Node support policy,
workspace dependency rules, and exact harness SDK pinning. An implementation
in another language need not depend on either npm package; it must satisfy the
same wire fixtures and applicable behavioral scenarios using its own codec and
tests.

## Provisional operations

External-effect intent, claim, dispatch, result recording, and effect
reconciliation have no current consumer, owner, Protocol kind/capability,
public API, durable record, state shape, or runtime operation. Interrupt,
resource release, session or agent ownership, general lifecycle hooks, remote
reconnect, and an adapter-owned durable sidecar likewise have no generic v0.1
contract.

Do not publish stable capability tokens, placeholder dispatch, or shared
runtime abstractions for these concepts. Promotion requires a dedicated
accepted Issue and any required ADR that name the consumer and owner; define
the Protocol kind/capability; define the durable record, authority, and state
shape; define failure, unknown, retry, absence, and reconciliation semantics;
and identify executable tests. This inventory does not decide #83, #78, #81,
#72, or #87.

## Negative constraints

- Do not introduce harness or provider names into core, engine, protocol, or
  journal identity.
- Do not promote a native event shape into a generic adapter event schema.
- Do not require TypeScript, Node, npm packages, or a particular plugin model
  for all adapters.
- Do not make MCP or another external protocol the Aizign wire authority.
- Do not create a universal adapter runtime, executable test driver, adapter
  process protocol, or speculative `common`, `shared`, or runtime package.
- Do not require a second adapter before this contract can stand on its own.
