# Security policy

## Reporting a vulnerability

Report vulnerabilities through GitHub **Private vulnerability reporting**
(Security tab → Report a vulnerability). Do not open a public Issue.

Include:

- the affected crate/package and version or commit;
- reproduction steps and the expected boundary; and
- the observed behavior.

Do not include real credentials, tokens, private data, private paths, prompts,
or model output. Replace them with synthetic non-confidential values.

We aim to acknowledge a report within 7 days and provide an initial assessment
within 14 days. Details remain private until a fix and disclosure plan are
ready.

## Supported versions and platforms

During `0.x`, only the latest minor release is supported. Backports to older
minor releases are not provided.

The committed-prefix JSONL store is supported only on
`x86_64-unknown-linux-gnu`. Other targets fail closed and do not advertise
submit or reconciliation. x32 is intentionally unsupported and is present only
as a compile-time negative boundary. Opening a current state directory with an
older binary is unsupported and not technically prevented.

See [`docs/reference/compatibility.md`](docs/reference/compatibility.md) for the
complete compatibility contract.

## Threat model and data boundary

The normative v0.1 trust assumptions, threat classifications, guarantee
levels, enforcement owners, regression evidence, and known limitations are in
[`docs/security/threat-model.md`](docs/security/threat-model.md).

The allowed component data flows are in
[`docs/architecture/data-boundary.md`](docs/architecture/data-boundary.md).
In particular:

- the control journal excludes raw prompts, model output, reasoning,
  credentials, and environment;
- provider/harness identity remains inside the adapter;
- the control plane is trusted for state-path selection, assignment identity,
  and candidate-digest provenance;
- the committed journal is workflow-acceptance authority, while harness
  persistence is auxiliary;
- closed schemas and digests do not prove semantic provenance or authenticity;
  and
- owner-only files, advisory locks, and prefix SHA-256 do not protect against a
  malicious same-user process able to rewrite all state artifacts.

## Repository hygiene

- GitHub Actions permissions default to `contents: read`, and Actions are
  pinned by commit SHA.
- Fork pull requests do not receive secrets.
- Normal CI does not invoke an external model, live harness, browser, or
  provider login.
- `cargo xtask public-audit` checks tracked/package artifacts for known secret
  patterns, private paths, forbidden runtime directories, and dependency
  boundaries. It is not a runtime secret scanner and does not prove that an
  allowed opaque field is semantically safe.
