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

- the control journal schema has no dedicated fields for raw prompts, model
  output, reasoning, credentials, or environment, but allowed opaque string
  values are not secret-scanned; the current DSH `artifactRef` is model-supplied
  and can carry such data if a producer violates the metadata-only policy;
- provider/harness identity remains inside the adapter;
- human-readable Protocol error messages are operational diagnostics and can
  contain state-path or OS detail; model-facing adapter boundaries must retain
  the stable code and replace the raw message with a fixed safe message;
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
- `cargo xtask public-audit` checks every tracked path against forbidden
  names/components. Its fixed known-secret/private-path content patterns scan
  only tracked UTF-8 text without NUL bytes and exempt the rule-definition
  source itself. Binary, NUL-containing, and non-UTF-8 contents are skipped.
- The manifest audit validates its documented package metadata rules.
  `cargo package --list` and `npm pack --dry-run` prove that the package
  managers can enumerate a packable file set; the resulting lists are not
  evaluated against a repository safety policy, and package artifact contents
  and generated/untracked files are not secret-scanned.
