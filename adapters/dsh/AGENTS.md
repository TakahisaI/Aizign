# AGENTS.md — @aizign/adapter-dsh

This file is navigation for automated coding agents.
Human contributors may ignore it and should follow [CONTRIBUTING.md](../../CONTRIBUTING.md).
The language-neutral adapter behavior is owned by the
[harness adapter contract](../../docs/architecture/harness-adapter-contract.md).
DSH-native behavior is owned by [README.md](README.md), source, and tests, not
by this navigation file.

## Read scope

1. [Harness adapter contract](../../docs/architecture/harness-adapter-contract.md)
2. [README.md](README.md)
3. [Hard invariants](../../docs/architecture/invariants.md)
4. [Threat model](../../docs/security/threat-model.md)
5. [Protocol v1](../../spec/protocol/v1/README.md)
6. `packages/protocol/src/client.ts`
7. [Adapter testkit](../../packages/adapter-testkit/README.md)
8. The adapter directory being edited

Do not read Rust crates unless the Issue explicitly requires investigation across the protocol boundary.

## Editing boundary

- Keep harness-specific types and SDK usage inside this adapter.
- Protocol behavior is changed through `spec/` and conformance fixtures, not by reading or importing core internals.
- SDK-version or runtime-dependency changes follow the Issue and ADR process in `CONTRIBUTING.md`.
- Put behavior and invariants in source, tests, the adapter README, or architecture docs—not in this file.

## Check

```sh
npm test -w @aizign/adapter-dsh
cargo xtask check
```
