# ADR-0024: Require isolated adapter child environments

- Status: Accepted
- Date: 2026-08-28
- Related: ADR-0015, ADR-0017, ADR-0020, ADR-0022, Issue #78
- Acceptance: [`P78-6DFA123-A` as amended by `P78-6DFA123-A1`](https://github.com/TakahisaI/Aizign/issues/78#issuecomment-5449520451)
- Implementation checkpoint: [`I78-6DFA123-B`](https://github.com/TakahisaI/Aizign/issues/78#issuecomment-5449567430), amended by [`I78-6DFA123-B-A1`](https://github.com/TakahisaI/Aizign/issues/78#issuecomment-5449748306)
- Readiness: [Maintainer decision for slice S1](https://github.com/TakahisaI/Aizign/issues/78#issuecomment-5449956317)

## Context

The generic adapter contract required process bounds and identity isolation but
did not require a process-spawning adapter to construct a closed child
environment. DSH rebuilt the environment, yet its provisional production
transport still accepted arbitrary caller-provided entries. Testkit faults and
benchmark controls used that production escape, so another adapter could
inherit credentials or harness identity while appearing conformant.

Capability absence was also described too broadly. `CAPABILITY_UNSUPPORTED` is
a core response for a decoded registered operation that the serving
binary/build/target does not provide. It is not a response synthesized from a
successful hello, nor an adapter-native feature result.

## Decision

Make the harness adapter contract the language-neutral authority for child
environment construction. Every process-spawning adapter starts from an empty
mapping and adds only a closed documented allowlist. It does not copy the
parent environment wholesale or expose an open production environment map.

DSH's single production `OneShotCoreClient` passes exactly the parent `PATH`
when present and otherwise an empty mapping. PATH supports an already
configured absolute executable whose shebang may use `/usr/bin/env`; it does
not add relative paths, discovery, cwd, shell invocation, or arbitrary
interpreter configuration. Tests and benchmarks inject their controls inside
generated non-production executable wrappers.

Keep capability absence source-qualified:

- a successful correlated hello missing required submit capability is a
  parent compatibility failure, mapped by DSH to `AIZIGN_INCOMPATIBLE`;
- optional reconciliation absence is a caller-local compatibility observation
  and causes no reconcile request; and
- harness-native integration absence remains adapter-owned availability or
  non-exposure.

For successful-hello protocol-version or required-capability incompatibility,
DSH parent timing records `preflight` / `rejected` with no `error_code` and no
`unknown_reason`. Only an actual decoded peer error can disclose its fixed code
under the existing timing rule.

`CAPABILITY_UNSUPPORTED` means that a binary decoded a Protocol-registered
operation request under an accepted operation version but the current
binary/build/target does not provide it. Classification continues to own how an
actually received code is classified, not who may produce it.

This decision partially supersedes only ADR-0020's arbitrary caller-provided
production child-environment entries. It preserves ADR-0020's sole DSH
production transport owner and closed experimental subpaths, ADR-0022's argv,
framing, version, and lifecycle ownership, and ADR-0017's classification
ownership. The experimental evidence surface remains Issue #80's responsibility.

## Consequences

### Positive

- Credentials, harness identity, diagnostics, and test hooks are excluded by
  construction rather than by a growing denylist.
- Native launch tests can compare the complete child environment with the
  documented adapter allowlist.
- Core capability, optional core extension, and harness-native absence no
  longer share a synthetic Protocol error.
- Production transport configuration cannot be reused as a fault-injection
  channel.

### Negative / risks

- Repository tests and benchmarks must maintain generated executable wrappers.
- A future production child variable requires a new accepted contract naming
  its purpose and owner.
- PATH remains ambient executable-search state for an absolute script's
  interpreter, although the configured executable itself remains authoritative.

### Follow-up

- Issue #79 owns DSH submission lifecycle.
- Issue #80 owns the experimental evidence surface and its bounds/removal.
- A second adapter must document and natively test its own exact allowlist; it
  does not inherit DSH's implementation.

## Alternatives considered

- **Keep arbitrary explicit variables as trusted caller input.** Rejected
  because it leaves a production credential and test-hook escape.
- **Pass an empty environment unconditionally.** Rejected for DSH because an
  absolute executable script may use `/usr/bin/env` in its shebang.
- **Create a universal adapter process runtime or environment manifest.**
  Rejected because one implementation does not justify a shared runtime and
  Protocol v1 has no harness-capability manifest.
- **Reuse `CAPABILITY_UNSUPPORTED` for every unavailable feature.** Rejected
  because it erases producer and observation authority.
