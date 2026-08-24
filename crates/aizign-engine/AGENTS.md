# AGENTS.md — aizign-engine

This file is navigation for automated coding agents.
Human contributors may ignore it and should follow [CONTRIBUTING.md](../../CONTRIBUTING.md).
The crate contract lives in [README.md](README.md), not here.

## Read scope

1. [README.md](README.md)
2. [Hard invariants](../../docs/architecture/invariants.md)
3. [Dependency rules](../../docs/architecture/dependency-rules.md), especially port ownership
4. The public `aizign-core` workflow API used by the change
5. The use case or port being edited

Do not read store, CLI, protocol, or adapter implementations unless the Issue explicitly requires a cross-boundary change.

## Editing boundary

- Keep ports owned by their consumer in this crate.
- Add a port only with matching updates to the crate README and dependency rules.
- Dependency or crate-boundary changes follow the Issue and ADR process in `CONTRIBUTING.md`.
- Put behavior and invariants in source, tests, the crate README, or architecture docs—not in this file.

## Check

```sh
cargo test -p aizign-engine
cargo xtask public-audit
```
