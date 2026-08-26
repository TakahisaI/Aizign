# spec

This tree owns Aizign's machine-readable contracts. Documentation under
`docs/` explains those contracts; implementations under `crates/` and
`packages/` conform to them.

| Directory | Contract | Implementations / consumers |
|---|---|---|
| `protocol/vN/` | Wire contract: JSON Schema draft 2020-12 and examples | `crates/aizign-protocol`, `packages/protocol` |
| `journal/vN/` | Durable journal-record schemas | `crates/aizign-store-jsonl` |
| `store/vN/` | Committed-prefix metadata published by the JSONL writer | `crates/aizign-store-jsonl` |
| `classification/` | Unversioned current-operation classification contract; the corpus and schema land in the Issue #75 implementation slice | Rust, TypeScript, CLI, timing, and benchmark tests |
| `conformance/` | Fixtures whose decoder decisions must agree (`.frame` + `.expect.json`) | `cargo xtask conformance` for structure, Rust protocol tests, and TypeScript protocol tests |

- `vN` is a protocol, journal-schema, or store-layout version, independent of
  package versions (ADR-0008 and ADR-0013). Classification is deliberately
  unversioned and does not add another public version axis (ADR-0017).
- Do not change a released schema shape in place. Additive behavior uses a new
  kind or record kind; a breaking change increments the applicable version.
- Examples contain only fictional, non-confidential values.
