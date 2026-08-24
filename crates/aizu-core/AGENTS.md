# AGENTS.md — aizu-core

This file is navigation for automated coding agents.
Human contributors may ignore it and should follow [CONTRIBUTING.md](../../CONTRIBUTING.md).
The crate contract lives in [README.md](README.md), not here.

## Read scope

1. [README.md](README.md)
2. [Hard invariants](../../docs/architecture/invariants.md)
3. [Context map](../../docs/architecture/context-map.md)
4. [Dependency rules](../../docs/architecture/dependency-rules.md)
5. [Data boundary](../../docs/architecture/data-boundary.md)
6. The context directory being edited, such as `src/workflow/`

Do not read adapter, protocol, or store implementations unless the Issue explicitly requires a cross-boundary change.

## Editing boundary

- Keep changes inside this crate and the selected bounded context.
- Add a new context only with the matching `context-map.md` update.
- Dependency or crate-boundary changes follow the Issue and ADR process in `CONTRIBUTING.md`.
- Put behavior and invariants in source, tests, the crate README, or architecture docs—not in this file.

## Check

```sh
cargo test -p aizu-core
cargo xtask public-audit
```
