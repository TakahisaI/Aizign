# ADR-0014: Use RustCrypto sha2 for committed-prefix hashing

- Status: Accepted
- Date: 2026-08-24
- Related: ADR-0007, ADR-0009, ADR-0013, Issue #51, Issue #63

## Context

ADR-0013 fixes SHA-256 as the integrity digest for the writer-published committed prefix of `workflow.jsonl`. The digest lets the JSONL store reject a commit document whose byte boundary and journal contents disagree. It is store-internal metadata and does not cross the protocol boundary or become workflow candidate identity.

The repository does not implement cryptographic primitives locally, and `aizign-store-jsonl` currently permits only `serde` and `serde_json` as external runtime dependencies. A maintained SHA-256 implementation therefore requires a proposal-first dependency decision before the Issue #51 implementation changes manifests or runtime code.

## Decision

Add this exact workspace dependency in the Issue #51 implementation:

```toml
sha2 = { version = "=0.11.0", default-features = false }
```

Only `aizign-store-jsonl` may depend on it. Use `Sha256` and the `Digest` trait re-exported by `sha2`; do not add `digest` as a second direct dependency unless a later decision demonstrates a separate need.

RustCrypto `sha2` is described upstream as a pure-Rust, `no_std`-capable implementation maintained by the RustCrypto Developers in the [RustCrypto hashes repository](https://github.com/RustCrypto/hashes). Here, pure Rust means that cryptographic computation is not delegated to an external or system cryptography library; it does not mean that the dependency graph is unsafe-free, assembly-free, or FFI-free. Version 0.11.0 declares Rust 1.85 and `MIT OR Apache-2.0`, which fit the workspace Rust 1.97 and license policies. Its [tagged crate manifest](https://github.com/RustCrypto/hashes/blob/sha2-v0.11.0/sha2/Cargo.toml) defines `alloc` and `oid` as default features; neither is required for incremental hashing of the bounded journal prefix, so default features remain disabled. Do not enable `zeroize` or any other optional feature. Disabling default features does not force the software-only backend or disable target-selected hardware intrinsics and inline assembly.

The dependency was resolved from the tracked lockfile baseline with the proposed exact direct dependency. The normal dependency graph is:

```text
sha2 0.11.0
├── cfg-if 1.0.4
├── cpufeatures 0.3.0 [aarch64, x86, x86_64 only]
│   └── libc 0.2.189 [target-specific]
└── digest 0.11.3
    ├── block-buffer 0.12.1
    │   └── hybrid-array 0.4.14
    │       └── typenum 1.20.1
    └── crypto-common 0.2.2
        └── hybrid-array 0.4.14
```

The resolved policy metadata is:

| Crate | Version | Enabled role / condition | Declared MSRV | License |
|---|---:|---|---:|---|
| `sha2` | 0.11.0 | direct; default features disabled | 1.85 | MIT OR Apache-2.0 |
| `digest` | 0.11.3 | default `block-api` support required by `sha2` | 1.85 | MIT OR Apache-2.0 |
| `cfg-if` | 1.0.4 | unconditional backend selection | 1.32 | MIT OR Apache-2.0 |
| `cpufeatures` | 0.3.0 | target-specific CPU feature detection | 1.85 | MIT OR Apache-2.0 |
| `crypto-common` | 0.2.2 | unconditional digest support | 1.85 | MIT OR Apache-2.0 |
| `block-buffer` | 0.12.1 | unconditional block buffering | 1.85 | MIT OR Apache-2.0 |
| `hybrid-array` | 0.4.14 | unconditional fixed-size storage | 1.85 | MIT OR Apache-2.0 |
| `typenum` | 1.20.1 | unconditional type-level lengths | 1.41.0 | MIT OR Apache-2.0 |
| `libc` | 0.2.189 | through `cpufeatures` on its supported target conditions | 1.65 | MIT OR Apache-2.0 |

`sha2` selects `cpufeatures` only on `aarch64`, `x86`, and `x86_64`. In this graph, `libc` is reachable with its default features disabled through `cpufeatures` on `aarch64` Android, Linux, and Apple targets; it is not an unconditional host dependency. On applicable `aarch64` targets, [`cpufeatures` contains target-specific `libc` FFI bindings](https://github.com/RustCrypto/utils/blob/cpufeatures-v0.3.0/cpufeatures/src/aarch64.rs) for CPU feature detection. The SHA-256 computation itself is not delegated to `libc` or another system cryptography library.

`cargo tree -e features` confirms that no `sha2` feature is enabled: `sha2/alloc`, `sha2/oid`, and `sha2/zeroize` are all absent. The enabled transitive features are `cfg-if/default`, `cpufeatures/default`, `digest/default` and therefore `digest/block-api`, `block-buffer/default`, `crypto-common/default`, `hybrid-array/default`, and `typenum/default` plus `typenum/const-generics`. `libc` is reached with its default features disabled. No random-number, hex-encoding, or external/system cryptography implementation is introduced.

The current `cargo deny check` passes with this resolved graph. Every new license is already admitted by `deny.toml`, so the implementation must not change the license allowlist unless its actual resolved graph differs and a reviewed policy reason exists. The historical [RUSTSEC-2021-0100](https://rustsec.org/advisories/RUSTSEC-2021-0100.html) miscomputation affected `sha2` 0.9.7 and is patched from 0.9.8; 0.11.0 is outside the affected range. The normal advisory gate still applies when the dependency is introduced.

Store-metadata version 1 fixes the algorithm to SHA-256. It does not carry an algorithm selector. Changing the algorithm requires a new store-metadata version and migration decision rather than runtime algorithm negotiation.

The digest covers exactly the first `committedBytes` bytes named by `workflow.commit.json`. It excludes every unpublished tail byte. Hashing during reconciliation only recomputes and compares that prefix; it never publishes, promotes, truncates, repairs, synchronizes, or otherwise changes store state.

This SHA-256 value detects mismatch between the published commit document and the journal prefix read by the store. It is not a MAC, signature, authentication mechanism, or proof against a same-user process that can rewrite both files. Issue #52 owns that threat-model limitation.

## Consequences

### Positive

- The store uses a maintained, narrowly scoped SHA-2 implementation instead of repository-local cryptography.
- Exact version and disabled defaults keep the reviewed direct dependency stable.
- The resolved graph uses only licenses already allowed by the repository.
- Dependency ownership remains inside the JSONL store boundary.

### Negative / Risks

- Nine runtime packages, including `sha2`, are added to the resolved lockfile graph on targets that include every conditional dependency.
- Patch releases of transitive dependencies remain controlled by `Cargo.lock` rather than exact direct pins; dependency updates require the normal review and `cargo deny` gates.
- CPU feature detection adds target-specific `libc` FFI bindings on applicable `aarch64` targets, although the hash computation does not use a system cryptography provider.
- [`sha2` backend selection](https://github.com/RustCrypto/hashes/blob/sha2-v0.11.0/sha2/src/sha256.rs) contains dependency-internal unsafe hardware-intrinsic paths on `x86` / `x86_64` and `aarch64`, and an [inline-assembly backend](https://github.com/RustCrypto/hashes/blob/sha2-v0.11.0/sha2/src/sha256/loongarch64_asm.rs) selected automatically on `loongarch64`. These paths are not controlled by the disabled Cargo default features. This decision accepts that transitive target-specific implementation surface while continuing to forbid unsafe code in Aizign-owned crates.
- The digest provides integrity comparison, not authentication.

### Follow-up

- The Issue #51 implementation updates the workspace dependency, `aizign-store-jsonl` manifest, tracked `Cargo.lock`, and `docs/architecture/dependency-rules.md` together.
- Update `deny.toml` only if the actual resolved graph requires an explicitly reviewed policy change.
- Add SHA-256 known-answer tests, including empty input; one-shot versus chunked hashing; exact-prefix tail exclusion; prefix mutation; and metadata mismatch.
- Prove that reconciliation performs no write, sync, initialization, repair, or tail promotion.

## Alternatives considered

- **Implement SHA-256 in the repository.** Rejected because cryptographic implementation and maintenance risk are not justified by avoiding this small dependency graph.
- **Use `ring`, OpenSSL, or AWS-LC.** Rejected because their broader algorithm, FFI, build, and platform surfaces are disproportionate to bounded SHA-256 hashing.
- **Use a convenience wrapper around SHA-256.** Rejected because it adds another ownership and dependency layer without improving this direct incremental-hashing use case.
- **Enable the `sha2` default features.** Rejected because `alloc` and object-identifier support are unnecessary.
- **Add `digest` as a direct dependency.** Rejected for this slice because `sha2` re-exports the trait needed by the store.
- **Negotiate the digest algorithm at runtime.** Rejected because store metadata needs one deterministic interpretation; algorithm evolution belongs to a new metadata version.
