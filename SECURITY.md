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

The accepted target contract for the committed-prefix JSONL store is store
metadata v2 under the sole profile `linux-x86_64-gnu-ext4-local-v1`; a target
triple alone is not sufficient. Other targets and storage profiles fail
closed. x32 remains only a compile-time negative boundary.

After the Issue #81 S1 specification change, the production runtime still
implements historical store metadata v1 and is not yet profile-qualified.
Runtime support moves to the accepted v2/profile contract only in the ordered
S2 implementation. A complete v2 store is fenced from the current v1 binary
by its `storeVersion: 2` commit marker. Initialization interrupted before that
marker is durable is not fenced, remains unsupported, and is
operator-discard-only. S1 does not claim those runtime changes are complete.

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
  values are not secret-scanned; the current DSH adapter removes `artifactRef`
  and `shortErrorCode` from the ordinary model surface and injects a closed
  trusted configuration, but a trusted producer or direct Protocol client can
  still carry prohibited content if it violates the metadata-only policy;
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
