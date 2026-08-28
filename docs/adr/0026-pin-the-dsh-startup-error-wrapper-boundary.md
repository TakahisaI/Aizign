# ADR-0026: Pin the DSH startup error wrapper boundary

- Status: Accepted
- Date: 2026-08-28
- Related: ADR-0010, ADR-0015, ADR-0025, Issue #72

## Context

ADR-0025 requires malformed trusted signal configuration to fail before
preflight, tool registration, or child-process spawn as one safe cause-free
`HarnessError`. The supported source-checkout adapter is loaded through pinned
DSH and Cordis packages. Those host packages add their own plain `Error`
wrappers while applying the adapter and include entries and while booting the
application.

The adapter owns its inner error, but it cannot suppress or replace host-owned
wrappers without changing the pinned loader, adding a compatibility path, or
misstating the diagnostic surface. The exact supported chain therefore needs
an explicit version-bound record.

## Decision

Keep these existing exact pins unchanged:

- `@deepseek-ai/dsh@0.1.1-rc.2`;
- `@deepseek-ai/dsh-app-boot@0.1.1-rc.2`; and
- `@deepseek-ai/cordis-plugin-loader@1.0.2`.

For malformed `trustedSignalValues`, the adapter throws exactly:

```text
HarnessError
  code: INVALID_EXPECTATION
  message: Aizign rejected invalid trusted signal configuration
  cause: absent
```

The supported DSH startup surface wraps that error in this exact outer chain:

```text
plain Error — @deepseek-ai/dsh-app-boot@0.1.1-rc.2
  cause:
    plain Error — @deepseek-ai/cordis-plugin-loader@1.0.2
      stage: apply
      entry: include (cordis:include)
      cause:
        plain Error — @deepseek-ai/cordis-plugin-loader@1.0.2
          stage: apply
          entry: aizign-workflow-signal (@aizign/adapter-dsh)
          cause:
            exact cause-free adapter HarnessError above
```

The wrappers are host-owned diagnostic context. They do not change the inner
machine code, authorize raw rejected values, or become a Protocol,
classification, retry, or workflow authority. CI must execute an invalid
profile through the pinned real loader and inspect the error objects and
causes, not merely search rendered text.

Changing a pin, wrapper count/order/type, stage, entry identity, inner code or
message, or adding an inner cause requires a new accepted contract. The
adapter must not add a dependency, loader patch, manifest/lockfile change,
compatibility alias, or error-chain repair to preserve this record.

## Consequences

- Startup failure remains safe and machine-identifiable at the adapter-owned
  inner boundary.
- Operators see the actual pinned host context instead of an invented flat
  error surface.
- A DSH or loader upgrade is intentionally blocked until its wrapper behavior
  is reviewed and this decision is superseded.

## Alternatives considered

- **Flatten or unwrap host errors.** Rejected because the adapter does not own
  the loader boundary.
- **Accept any rendered message containing `INVALID_EXPECTATION`.** Rejected
  because string matching does not prove wrapper identity, ordering, or the
  absence of a sensitive cause.
- **Change or patch the loader.** Rejected as unnecessary scope and a new
  dependency/compatibility surface.
