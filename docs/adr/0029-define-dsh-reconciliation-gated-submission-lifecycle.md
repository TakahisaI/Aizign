# ADR-0029: Define the DSH reconciliation-gated submission lifecycle

- Status: Accepted
- Date: 2026-08-30
- Related: ADR-0013, ADR-0020, ADR-0025, ADR-0028, Issue #79

## Context

The DSH adapter currently performs one transport attempt per model tool call,
but it does not own a logical-submission lifecycle. A durable core append can
succeed while its acknowledgement is lost. A concurrent call, later model
call, or adapter restart can then create a new request ID and submit the same
configured event again. Per-call absence of a retry loop does not prevent this
logical retry.

Issue #79 requires one DSH-owned pre-spawn fence that retains the exact trusted
signal, survives restart, and keeps model-visible submit unavailable until an
explicit read-only reconciliation resolves an unknown outcome. The core
journal remains the workflow authority; the adapter must not make
reconciliation effectful or infer permission to resubmit from `absent`.

## Decision

Adopt the versioned authority in
[`spec/dsh/lifecycle/v1/`](../../spec/dsh/lifecycle/v1/README.md). DSH is the
sole production owner of this lifecycle. Protocol, classification, core,
engine, CLI, and the JSONL store retain their existing responsibilities.

### Identity and storage

The logical identity is `(lifecycleRootId, eventId)`. One qualified lifecycle
root supports multiple event records, each at the canonical SHA-256 locator
defined by lifecycle v1. Explicit initialization creates the root authority or
adds one new event without adopting, resetting, repairing, or rewriting another
event.

The adapter uses the separate
`dsh-lifecycle-linux-x86_64-gnu-ext4-local-v1` profile. It does not claim to
implement, consume, or replace the core store-v2 qualifier. The lifecycle and
core state paths must pass their independent checks and share the exact mount
identity required by the lifecycle profile.

Changing, replacing, or deleting the root or event record is an unsupported
external discard/reset that abandons the prior no-resubmission guarantee. No
reset, delete, migrate, discover, or cross-root API is provided.

### Admission and publication

Within one JavaScript process, an exclusive live-owner lease permits at most
one controller for a logical identity across Cordis scopes and plugin
instances. That controller has one non-waiting operation gate shared by submit
and reconcile. A competing call returns the fixed busy result before resolver
use, request-ID creation, mutation, or child spawn.

For an admitted submit, DSH resolves the ADR-0025 trusted pair exactly once,
creates one request ID, and durably publishes `in_flight` with the incremented
attempt sequence and exact retained pair. The child may spawn only after the
file and namespace barriers succeed. Known submit or reconciliation results are
not exposed until their lifecycle transition is durable. A later publication
failure remains unknown/unavailable and keeps submit gated.

Persisted `in_flight` becomes `needs_reconciliation` durably during startup
before service or tool publication. Unknown states never become `ready` by
restart, state loss, timeout, abort, or inference.

### Reconciliation and projections

The control-plane-only Cordis service
`aizignWorkflowSignalLifecycle` may inspect status and invoke one read-only
reconciliation of the exact retained signal. It is not model-visible and never
calls submit. `accepted`, `conflict`, `absent`, and `unknown` map to the closed
lifecycle states defined by the specification. `reconciled_absent` is terminal
for v0.1 and authorizes neither retry nor submit.

The stable DSH package root remains the exact plugin-entry surface from
ADR-0020. The accepted provisional lifecycle API belongs only to
`@aizign/adapter-dsh/experimental/lifecycle`; its exact allowlist is defined by
the lifecycle specification. The existing `./experimental/transport` surface
and submit-only exported preflight remain unchanged.

Disposal permanently closes captured tool and control references before the
process-local lease is released. Old references never reconnect to a later
controller.

## Compatibility and implementation ordering

This is a pre-v0.1 breaking target. Existing configurations lack
`lifecycleRoot` and `lifecycleRootId`, and existing runtime behavior has no
durable lifecycle. There is no compatibility alias, in-memory fallback,
automatic initialization, or migration.

The first slice records this ADR, the normative lifecycle-v1 specification,
schemas, closed evidence inventory, and target/current documentation only. It
does not make the runtime conforming. A later atomic slice must migrate config,
storage qualification/publication, controller ownership, service/tool
composition, package exports, documentation, and all executable evidence
together.

## Consequences

### Positive

- A lost acknowledgement cannot be followed by a blind submit from the same
  supported lifecycle across concurrency or restart.
- The exact attempted signal and trusted mapping survive before the first
  child spawn.
- Reconciliation stays read-only and journal-authoritative.
- DSH lifecycle storage has one explicit owner and support profile without
  weakening the core store boundary.
- Model and control-plane projections are closed and payload-free.

### Negative / risks

- Operators must explicitly provision and retain a qualified lifecycle root.
- Only one DSH process may own a root; there is no leader election or remote
  coordination.
- Partial initialization and ambiguous publication fail closed and may require
  operator discard rather than repair.
- A valid core journal replacement at the same configured path is not detected
  by `coreStatePathKey`; path preservation remains a trusted control-plane
  responsibility.
- The durable fence adds synchronization work before every submit and state
  transition.

## Rejected alternatives

- **Rely on transport no-retry:** does not prevent another logical model call.
- **Keep state only in memory:** restart silently loses the unknown fence.
- **Reuse the core store or Protocol:** moves adapter lifecycle ownership into
  unrelated authorities.
- **Treat reconciliation `absent` as retry permission:** contradicts ADR-0013
  and the classification no-retry rule.
- **Expose reset/retry or a generic scheduler:** expands beyond the bounded
  v0.1 safety requirement.
- **Coordinate multiple DSH processes:** requires a separate ownership and
  failure contract.
