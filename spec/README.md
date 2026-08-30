# spec

This tree owns Aizign's machine-readable contracts. Documentation under
`docs/` explains those contracts; implementations under `crates/` and
`packages/` conform to them.

| Directory | Contract | Implementations / consumers |
|---|---|---|
| `protocol/vN/` | Wire contract: JSON Schema draft 2020-12 and examples | `crates/aizign-protocol`, `packages/protocol` |
| `journal/vN/` | Durable journal-record schemas | `crates/aizign-store-jsonl` |
| `store/vN/` | JSONL store layout, committed-prefix metadata, and publication witness | `crates/aizign-store-jsonl` |
| `process/vN/` | Adapter/core process argv, framing, lifecycle, bootstrap selection, and process faults | CLI, adapters, fake cores, and benchmark process consumers |
| `dsh/lifecycle/vN/` | Planned DSH-owned logical-submission lifecycle, storage profile, closed record shapes, and evidence inventory | Future DSH lifecycle S2 implementation and tests |
| `classification/` | Unversioned current-operation classification corpus and its closed sibling schema | Rust, TypeScript, CLI, timing, and benchmark tests |
| `conformance/` | Fixtures whose decoder decisions must agree (`.frame` + `.expect.json`) | `cargo xtask conformance` for structure, Rust protocol tests, and TypeScript protocol tests |

- `vN` is a process-profile, protocol, journal-schema, or store-layout version,
  independent of package versions (ADR-0008, ADR-0013, and ADR-0022). A process
  profile is also independent of the operation Protocol version.
  Classification is deliberately unversioned and does not add another public
  version axis (ADR-0017).
- Do not change a released schema shape in place. Additive behavior uses a new
  kind or record kind; a breaking change increments the applicable version.
- Examples contain only fictional, non-confidential values.

`store/v2/` is the sole current store-layout authority. Its README,
closed commit/witness schemas, examples, and exact 38-case corpus are one
versioned authority package. `store/v1/` is retained unchanged as a historical
unsupported format for compatibility-rejection evidence. Production implements
v2 atomically; specification acceptance by itself remains distinct from a
support claim for any additional profile.

`dsh/lifecycle/v1/` is the accepted target authority introduced by ADR-0029.
It is not implemented by the current runtime. Its lifecycle storage profile is
independent of store v2, and acceptance of the specification is not a current
compatibility or support claim.
