# AGENTS.md

This file is navigation for automated coding agents.
Human contributors may ignore it and should follow [CONTRIBUTING.md](CONTRIBUTING.md).
It is not an architectural, behavioral, or contribution-policy authority.

## Authority

- Current behavior: source, tests, and `spec/conformance/`
- Wire and durable contracts: `spec/`
- Current architecture and hard invariants: `docs/architecture/`
- Security assumptions and guarantee levels: `docs/security/threat-model.md`
- Decision history: `docs/adr/`
- Human contribution policy: `CONTRIBUTING.md`
- Package contract: the nearest `README.md`

Do not copy those contracts into `AGENTS.md`. Update the authoritative file instead.

## Read before editing

| Need | Read |
|---|---|
| Overall architecture | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Hard invariants | [docs/architecture/invariants.md](docs/architecture/invariants.md) |
| Code placement | [docs/architecture/context-map.md](docs/architecture/context-map.md) |
| Dependency direction | [docs/architecture/dependency-rules.md](docs/architecture/dependency-rules.md) |
| Data crossing boundaries | [docs/architecture/data-boundary.md](docs/architecture/data-boundary.md) |
| Harness adapter behavior | [docs/architecture/harness-adapter-contract.md](docs/architecture/harness-adapter-contract.md) |
| Security or trust boundaries | [docs/security/threat-model.md](docs/security/threat-model.md) |
| Contribution process | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Boundary and Milestone pilot workflow | [docs/development/change-workflow.md](docs/development/change-workflow.md) |
| Manual review brief | [docs/development/review-brief.md](docs/development/review-brief.md) |

Read the `AGENTS.md` nearest to the file being edited. The nearest file narrows this repository-level navigation.

## Editing boundary

- Keep the change within the Issue's bounded context unless the Issue explicitly requires a cross-context slice.
- Do not create `common/`, `utils/`, `shared/`, or a global dependency container.
- Do not infer completion from prose, idle state, or screen state; follow the [hard invariants](docs/architecture/invariants.md).
- Do not publish, merge, delete, force-update, or change repository visibility without explicit human authorization.

## Check

```sh
cargo xtask check
```
