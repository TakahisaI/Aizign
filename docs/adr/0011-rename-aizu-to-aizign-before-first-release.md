# ADR-0011: Rename Aizu to Aizign before the first release

- Status: Accepted
- Date: 2026-08-24
- Related: ADR-0001, ADR-0003, ADR-0008, ADR-0009, ADR-0010, Issue #46, PR #45

## Context

The project and repository started under the name Aizu. Before the first GitHub Release or registry publication, the repository was renamed to Aizign. The old name still appeared in the CLI and Rust crate names, the npm scope, the Protocol v1 envelope identifier, environment variables, test fixtures, and documentation.

Leaving those identifiers split between Aizu and Aizign would make installation instructions, package metadata, process invocation, compatibility checks, and diagnostics disagree about the identity of the same system. The rename crosses crate and package boundaries and changes a protocol field, so it requires an ADR.

No released artifact, published package, or supported Protocol v1 peer exists under the old name. This makes a coordinated in-place rename possible without carrying compatibility aliases into the first release.

## Decision

- Use **Aizign** as the project and product name and **aizign** as its lowercase identifier.
- Rename all Rust crates from `aizu-*` to `aizign-*`, and rename the CLI package and binary to `aizign-cli` and `aizign`.
- Rename all TypeScript packages from `@aizu/*` to `@aizign/*`, and rename the private workspace root to `aizign-workspace`.
- Use `"aizign"` as the Protocol v1 envelope `protocol` value. The old `"aizu"` value is rejected as `INVALID_ENVELOPE`.
- Keep the protocol version and journal schema version at `1`. Because neither has been released, update their v1 specifications and conformance fixtures in place instead of creating a compatibility-only v2.
- Rename project-owned environment variables, adapter identifiers, temporary paths, state-directory examples, diagnostics, and active audit identifiers from `AIZU` / `aizu` to `AIZIGN` / `aizign`.
- Continue ignoring and rejecting tracked paths under both `.aizu-state/` and `.aizign-state/`. Retaining the old path in `.gitignore` and `public-audit` is a security quarantine for existing checkouts, not a compatibility alias for the old binary or protocol.
- Do not provide old binary names, package aliases, npm scope aliases, protocol aliases, or environment-variable fallbacks.
- Preserve the text and filenames of ADR-0001 through ADR-0010 as historical records. Their references to Aizu describe the name in use when those decisions were accepted; current names and contracts are defined by this ADR and the current architecture, source, tests, and `spec/` tree.

## Consequences

### Positive

- The repository, packages, binary, protocol, diagnostics, and documentation expose one project identity.
- The first release does not carry permanent compatibility code for an unreleased name.
- Package metadata and copy-paste commands point directly at the renamed repository and artifacts.

### Negative / Risks

- Existing local development commands, state-directory names, and adapter patches using the old identifiers must be updated together.
- Frames using `"protocol":"aizu"` no longer decode as Protocol v1.
- Consumers cannot mix pre-rename and post-rename workspace artifacts.

### Follow-up

- Keep a negative request and response conformance fixture for the old protocol identifier.
- Run `cargo xtask check` after the coordinated rename so Cargo, npm, schema, Rust, TypeScript, adapter, documentation, and packaging checks cover the same tree.
- Verify that active files contain no old project identifier except the explicit negative protocol fixtures and legacy state-directory quarantine; historical ADRs are the other allowed exception.

## Alternatives considered

- **Rename only the GitHub repository** — rejected because package metadata, commands, and protocol identity would continue to advertise the old name.
- **Keep aliases for the old binary, packages, environment variables, and protocol identifier** — rejected because no release requires compatibility, and aliases would create two public identities from the start.
- **Introduce Protocol v2 only for the name change** — rejected because Protocol v1 has not been released; maintaining an unreleased compatibility version would add permanent negotiation and test cost without a consumer benefit.
