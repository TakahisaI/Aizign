# ADR-0020: Narrow TypeScript exports and own DSH transport

- Status: Accepted
- Date: 2026-08-26
- Related: ADR-0003, ADR-0005, ADR-0010, ADR-0017, ADR-0018, Issue #74, Issue #89
- Acceptance: [Maintainer v0.1 guarantee rebaseline](https://github.com/TakahisaI/Aizign/issues/74#issuecomment-5421509913)
- Implementation checkpoint: [`I89-A8A3FD0-A`](https://github.com/TakahisaI/Aizign/issues/89#issuecomment-5426502135), amended by [`I89-A8A3FD0-A1`](https://github.com/TakahisaI/Aizign/issues/89#issuecomment-5426909643)
- Readiness: [Maintainer decision for slice `S1`](https://github.com/TakahisaI/Aizign/issues/89#issuecomment-5426990095)

## Follow-up status — 2026-08-27

The Issue #75 `S1` follow-up removes the temporary Protocol classification
helpers retained by this decision. DSH remains the sole production TypeScript
transport owner, keeps its existing experimental timing export, and applies a
minimal operation projection checked against all 78 corpus rows. The decision
text below remains the historical ownership decision and retains its original
prospective wording.

## Context

The TypeScript Protocol root mixed language-neutral wire/client semantics with
Node process configuration and DSH parent-timing vocabulary. The adapter
testkit also contained `ReferenceOneShotClient`, a second implementation of
the production DSH client's spawn, environment, timeout, frame, correlation,
outcome, and timing policy. A transport fix therefore had to be copied and
proved twice even though v0.1 supports only the DSH adapter.

The DSH package root exposed plugin entry points together with transport,
configuration, mapping, digest, preflight, timing, and cold-read internals.
Repository benchmarks bypassed the package export maps by importing generated
`lib/index.js` files directly. All three packages are private, unpublished,
and have no supported external SDK consumer, so preserving those accidental
surfaces would add compatibility debt without protecting a current user.

Issue #75 will later replace current classification consumers with the
accepted language-neutral corpus. This decision must not change current
classification, wire, retry, correlation, timing, plugin, or benchmark metric
semantics while changing ownership and visibility.

## Decision

Keep `@aizign/protocol` Node-free. Its stable root owns Protocol v1 codecs and
DTOs, bounds and one-frame extraction, fixed errors, hello compatibility,
identifier validation, the abstract `CoreClient` operation/result contract,
pure response correlation, and the current classification helpers pending
Issue #75. Process configuration and all parent-timing vocabulary move out of
Protocol. Unused low-level helpers cease to be root exports.

Make `adapters/dsh/src/core-client/one-shot-client.ts` the only production
TypeScript one-shot transport owner. DSH owns its process configuration,
explicit environment, lifecycle, timeout/abort, outcome mapping, parent
timing, and preflight. The stable DSH root is only the Cordis plugin entry:
`name`, `inject`, `Config`, `PluginConfig`, and `apply`.

Repository control-plane and benchmark consumers use two closed provisional
DSH subpaths:

- `./experimental/transport` exposes only the production client, preflight,
  `isTimingErrorCode`, and their exact configuration/timing types;
- `./experimental/evidence` exposes only the current cold-read operation,
  presentation metadata function, constants, and their exact named types.

The complete runtime and type allowlists are fixed by checkpoint amendment
`I89-A8A3FD0-A1` and enforced from built runtime modules and declarations.
Issue #80 deletes the evidence subpath; neither subpath is a stable SDK.

Delete `ReferenceOneShotClient` and its tests without an alias. Keep
`@aizign/adapter-testkit` as a fake core, scripted fault producer,
language-neutral fixture/assertion set, and conformance runner applied to a
supplied production client factory. Move timing-specific evidence to DSH
tests, and apply fake and real-binary scenarios directly to
`OneShotCoreClient`.

Migrate benchmarks to declared package specifiers, the production DSH client,
and the DSH timing allowlist. Rename the current transport label from
`typescript_reference` to `typescript_dsh` and increment the runner version
from 5 to 6. Historical result files remain history and are not rewritten.

Extend repository audit to enforce exact package subpaths and TypeScript
workspace dependency directions, reject source/build-path bypasses, keep
Protocol free of process/DSH timing vocabulary, and prevent the duplicate
reference transport from returning. Runtime and declaration tests enforce the
exact symbol allowlists and negative deep-import behavior.

## Consequences

### Positive

- A production transport fix has one TypeScript implementation and one direct
  conformance matrix.
- Protocol remains usable as a language-neutral TypeScript convenience layer
  without Node process or DSH timing policy.
- Stable DSH imports describe the plugin entry rather than an accidental SDK.
- Repository-only provisional consumers are explicit and mechanically closed.
- Benchmark measurements exercise the production DSH transport instead of a
  duplicate reference implementation.

### Negative / Risks

- Repository control-plane consumers temporarily depend on explicit
  experimental DSH subpaths.
- TypeScript tests and audits carry exact symbol allowlists that must change in
  the same accepted slice as any legitimate export change.
- Testkit factories use a structural fixture configuration rather than a
  production configuration type; adapter tests must prove that their client
  accepts that fixture shape.
- Current classification helpers remain in Protocol until Issue #75, so this
  ownership contraction does not yet remove the planned consumer migration.

### Follow-up

- Issue #75 replaces current classification consumers without reintroducing
  process/timing policy into Protocol.
- Issues #76 and #77 change the canonical process and codec boundaries only
  after this single-owner transition.
- Issue #80 removes the experimental evidence subpath and stable support
  claims for DSH cold read.
- Return to Issue #89 and a new or superseding ADR before stabilizing a
  transport SDK, adding a second production client/adapter runtime, or adding
  compatibility for a supported external package consumer.

## Alternatives considered

- **Keep the reference client as an independent oracle.** Rejected because it
  duplicates the exact production policy being tested and can pass while DSH
  drifts.
- **Move all abstract client and framing semantics into DSH.** Rejected because
  operation outcomes, correlation, and bounded Protocol framing are Node-free
  language-neutral primitives, not DSH process ownership.
- **Keep broad DSH root exports until publication.** Rejected because the
  packages are already consumed inside the repository and accidental roots
  become harder to remove with each new consumer.
- **Create a universal adapter runtime.** Rejected because v0.1 has one
  qualified adapter and no second implementation proving a common runtime is
  needed.
- **Split export removal, consumer migration, and transport deletion across
  pull requests.** Rejected because intermediate states require a compatibility
  re-export, a broken consumer, or two production owners.
