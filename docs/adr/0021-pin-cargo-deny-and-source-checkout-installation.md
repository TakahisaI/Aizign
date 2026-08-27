# ADR-0021: Pin cargo-deny and define source-checkout installation

- Status: Accepted
- Date: 2026-08-27
- Related: ADR-0008, ADR-0010, ADR-0015, ADR-0018, Issue #74, Issue #84
- Acceptance: [Maintainer readiness for Issue #84 / S1](https://github.com/TakahisaI/Aizign/issues/84#issuecomment-5433239292)
- Implementation checkpoint: [`I84-5D36DC0-A`](https://github.com/TakahisaI/Aizign/issues/84#issuecomment-5432721199), amended by [`A1`](https://github.com/TakahisaI/Aizign/issues/84#issuecomment-5432871022), [`A2`](https://github.com/TakahisaI/Aizign/issues/84#issuecomment-5432964963), and [`A3`](https://github.com/TakahisaI/Aizign/issues/84#issuecomment-5433166429)
- Readiness: [S1 authorization](https://github.com/TakahisaI/Aizign/issues/84#issuecomment-5433239292)

## Context

The repository used the cargo-deny `0.20.2` value in CI and release workflow
action inputs, while local setup described the latest stable release and the
security workflow delegated installation to a separate action. `cargo xtask
rust-check` only checked that a cargo-deny executable existed. These paths could
therefore audit the same checkout with different tools without a deterministic
failure before the audit command.

The TypeScript packages are a private, unpublished npm workspace. The DSH
adapter has a production dependency on the private Protocol package, so its
packable tarball is not an independently installable v0.1 distribution. The
repository needs one supported installation form that does not imply registry
publication or a standalone archive.

## Decision

Make the repository-root `.cargo-deny-version` file the sole cargo-deny version
authority. It contains the UTF-8 bytes for `0.20.2` followed by exactly one LF
byte (`0x0A`), with no literal backslash-`n`, extra whitespace, or second line.
`deny.toml` remains the policy configuration and is not a second version
authority.

CI, release, and security workflows derive their installation input from that
file. The security workflow uses the repository-pinned Rust toolchain and runs
the same `cargo deny check advisories bans licenses sources` command rather than
depending on a tool version embedded outside the repository.

After installation, the security workflow runs
`.github/scripts/check-cargo-deny-version.sh`, which compares the installed
`cargo deny --version` stdout byte-for-byte with the authority before the audit.

`cargo xtask rust-check` reads and validates the authority, then requires
`cargo deny --version` stdout to be exactly `cargo-deny 0.20.2` plus one
terminal LF before it invokes `cargo deny check`. Missing or malformed
authority, a missing executable, a non-zero version command, a different
executable name, extra tokens/whitespace, or a different version fails closed
and prints the exact pinned setup command.

The only supported v0.1 installation form is a reviewed/released source
checkout at its exact SHA, using the repository-pinned Rust/Node/npm toolchain,
`cargo fetch --locked`, `npm ci`, the Rust and TypeScript workspace builds, and
workspace links for `@aizign/protocol` and `@aizign/adapter-dsh`. `npm pack
--dry-run` and `cargo package --list` enumerate package shape only; they do not
qualify an independently installable artifact.

The clean-checkout CI fixture may bootstrap the third-party DSH host with the
exact `@deepseek-ai/dsh@0.1.1-rc.2` and `pnpm@11.7.0` packages through `npx`.
It sets a newly created temporary `DSH_HOME`, passes `add -w` so DSH's
temporary profile workspace is the pnpm workspace-root target, and allows only
the DSH web-app's native `koffi` build with `--allow-build=koffi`. This pnpm use
is fixture-only: Aizign remains npm-authoritative at `npm@12.0.2`, and no
`@aizign/*` registry package, standalone adapter archive, publication, or
bundling is supported by this decision. The fixture inspects only that temporary
profile and discards the temporary home after the assertion.

## Consequences

### Positive

- Local, CI, release, and scheduled security audits share one machine-readable
  cargo-deny authority and fail before an audit on version drift.
- A clean source checkout has a documented, reproducible v0.1 installation
  path that resolves the private workspace packages without implying registry
  support.
- DSH profile registration is tested without browser, login, model, credential,
  or live-smoke state, while the live DSH/Firefox procedure remains operator
  evidence.

### Negative / Risks

- Updating cargo-deny now requires changing the authority file and its derived
  evidence in one focused tooling PR.
- The DSH registration fixture depends on an exact third-party host bootstrap,
  but that dependency is deliberately isolated from Aizign's package-manager
  policy.
- A future registry or archive distribution requires a new accepted decision
  and paired-artifact/clean-install evidence; this ADR does not provide it.

## Follow-up

- Package artifact qualification, allowlists, and registry-free clean-install
  gates remain deferred to Issue #92 / RC-26.
- DSH/Firefox live smoke remains separate Issue #11/operator evidence.
- Revisit this ADR with a new accepted decision before publishing `@aizign/*`,
  bundling Protocol into an adapter archive, or changing the supported install
  boundary.

## Alternatives considered

- **Keep separate literal or action-embedded cargo-deny pins.** Rejected because
  drift would remain invisible until audit behavior differed.
- **Add a general tool/version manager.** Rejected because one pinned tool does
  not justify a new repository-wide manager.
- **Publish or bundle the adapter and Protocol now.** Rejected because v0.1 is
  source-only and package qualification/publication are outside Issue #84.
- **Treat `npm pack --dry-run` as installability proof.** Rejected because it
  enumerates the packable file set but does not close private dependency
  resolution or artifact safety.
- **Use a global pnpm workspace-root override.** Rejected because the DSH
  fixture must use explicit `add -w` and must not disable pnpm's safety check.
