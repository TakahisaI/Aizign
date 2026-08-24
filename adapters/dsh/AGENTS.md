# AGENTS.md — @aizu/adapter-dsh

This file is navigation for automated coding agents.
Human contributors may ignore it and should follow [CONTRIBUTING.md](../../CONTRIBUTING.md).
The adapter contract lives in [README.md](README.md), not here.

## Read scope

1. [README.md](README.md)
2. [Hard invariants](../../docs/architecture/invariants.md)
3. [Protocol v1](../../spec/protocol/v1/README.md)
4. `packages/protocol/src/client.ts`
5. [Adapter testkit](../../packages/adapter-testkit/README.md)
6. The adapter directory being edited

Do not read Rust crates unless the Issue explicitly requires investigation across the protocol boundary.

## Editing boundary

- Keep harness-specific types and SDK usage inside this adapter.
- Protocol behavior is changed through `spec/` and conformance fixtures, not by reading or importing core internals.
- SDK-version or runtime-dependency changes follow the Issue and ADR process in `CONTRIBUTING.md`.
- Put behavior and invariants in source, tests, the adapter README, or architecture docs—not in this file.

## Check

```sh
npm test -w @aizu/adapter-dsh
cargo xtask check
```
