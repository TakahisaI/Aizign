# Compatibility

## Version boundaries

| Version | 現在 | 管理 |
|---|---|---|
| Aizign package version | `0.1.0`（未release） | 全artifact lockstep。`Cargo.toml`、各 `package.json` |
| CLI process profile | `1`（current implementation） | `spec/process/v1/`。argv、frame、EOF、watchdog、process lifecycle。wire fieldではない |
| Bootstrap envelope version | `1`（framed `hello` とpre-operation errorのstable subset） | `spec/protocol/v1/`。bootstrap axisとしてenvelopeの `version` を読む |
| Operation Protocol version | `1`（`aizign-protocol` が実装。`workflow.signal.submit`、`workflow.signal.reconcile`） | `spec/protocol/v1/`。operation axisとしてenvelopeの `version` を読む |
| Journal schema version | `1`（`aizign-store-jsonl` が実装） | `spec/journal/v1/`。recordの `schemaVersion` |
| Store metadata version | `2`（current implementation） | `spec/store/v2/`。historical rejection formatは`spec/store/v1/` |

adapterはpackage versionの完全一致ではなく、canonical process profileでframed
`hello`を実行し、得られたoperation Protocol versionとcapabilityで互換性を判定します
（[ADR-0003](../adr/0003-use-a-versioned-ndjson-process-boundary.md)、
[ADR-0022](../adr/0022-define-the-canonical-one-shot-process-profile.md)、
[ADR-0023](../adr/0023-define-protocol-lexical-and-outbound-validation-boundaries.md)、
[ADR-0008](../adr/0008-use-lockstep-artifact-versions-before-1-0.md)）。
process profile、bootstrap envelope、operation Protocolは独立したversion axisです。
現在値がすべて`1`であることは、同時に改版されることを意味しません。

## Bootstrap and operation selection

Canonical preflight is the state-independent framed request
`aizign handle --state <stateDir>` with `kind: "hello"`. Direct
`aizign hello` is a provisional operator command and is not interchangeable
with adapter preflight. The exact argv, frame, EOF, timeout, process-close,
and correlation rules are owned by the
[CLI process profile v1](../../spec/process/v1/README.md).

After a valid process frame, exact `kind: "hello"` selects the bootstrap
version axis. Every other syntactically valid kind selects the operation
version axis before operation membership is checked. Unsupported versions use
the bootstrap-v1 `PROTOCOL_VERSION_UNSUPPORTED` representation; an accepted
operation version with an unknown kind uses that operation version's
`UNKNOWN_KIND`. The bootstrap-v1 envelope, framed hello, and pre-operation
error schemas are an independently stable subset, so a future operation client
retains a bootstrap-v1 decoder for discovery and incompatibility responses.

The current CLI and TypeScript consumers implement this selection and framing.
Direct `aizign hello` remains operator diagnostics only.

## Protocol-family lexical compatibility

Every JSON number token in a Protocol frame uses the version-independent
source spelling `0` or `-?[1-9][0-9]*`. Decimal notation, exponent notation,
and negative zero are outside the Protocol family before bootstrap/operation
version selection. This applies to otherwise unsupported future-version
frames as well as current v1. A future operation version cannot introduce a
different JSON number spelling without a superseding ADR and explicit
compatibility decision; it must otherwise use a non-number representation.

Canonical integer source text remains lossless until an accepted version
supplies field semantics. Therefore an unsupported-version frame containing a
very large canonical payload integer reaches `PROTOCOL_VERSION_UNSUPPORTED`
without applying current-v1 payload bounds, while non-canonical lexical form
still fails first. This family-level boundary is owned by
[Protocol v1](../../spec/protocol/v1/README.md#version-independent-lexical-and-decode-pipeline)
and ADR-0023, not by package versions, JSON Schema, or one language parser.

ADR-0023 also establishes one validated frame encoder per direction and
language. Serializer coercion, payload-encoder bypasses, malformed-code
normalization, or source-object `toJSON` behavior are not compatibility paths.
The outbound constructor/export tightening is a deliberate pre-release public
surface change.

Issue #77 S2 implements these claims in both codecs and closes the affected
public surfaces. Shared lexical fixtures, encoder matrices, and package export
audits keep ADR-0023 conformance executable.

Accepted store v2 support is the exact
`linux-x86_64-gnu-ext4-local-v1` profile: exact target/word size plus fd-bound
mount identity, one exact ext4 mountinfo record, read-write/device checks, and
corroborative ext-family magic. A target triple or filesystem magic alone is
insufficient. x32 remains only a compile-time negative boundary.

Production implements this authority and qualifies every opened state/artifact
before it can establish a known result or mutate state. A complete v2 store is
fenced from a historical v1 binary because the retained commit path carries
`storeVersion: 2`, which v1 rejects before append. State
interrupted before that marker is durably published is not fenced and is
unsupported/operator-discard-only. There is no silent adoption, automatic
migration, dual reader, or repair path.

## Provisional timing evidence

Opt-in timing is internal, provisional operational evidence. It is not part of
Protocol v1, package compatibility, workflow authority, or a stable public
schema. In particular, the child timing record's current `schema_version: 1`
is only an internal producer/consumer guard. It carries no external stability
or migration promise.

The existing child timing source and DSH-owned provisional parent transport
timing APIs remain available, but their observations are source-qualified. A
child runtime observation and a parent transport observation must not be
interpreted as one universal semantic outcome. Process, preflight, and parent
timing are not Protocol package compatibility; repository consumers reach them
only through the closed DSH `./experimental/transport` subpath. The
[classification corpus](../../spec/classification/README.md) is the sole
cross-language row authority. Child, parent, and benchmark projections are
exhaustively checked against all rows without loading a shared runtime service.
That ownership does not promote timing into a compatibility surface.

The Issue #89 ownership move changes the package/import owner but not timing
fields, units, intervals, classification, or sink isolation. Its provisional
status does not weaken the current metadata-only shape or the guarantee that
observer/sink failure cannot change a workflow result.

Stabilizing timing later requires a separate accepted decision that defines an
owner, an independent version and lifecycle, intended consumers, and explicit
compatibility and migration rules.

## Security and guarantee limits

Compatibility does not widen the v0.1 trust boundary. In particular:

- selecting the intended initialized state directory is an operator/control-plane
  responsibility; v0.1 has no state-instance manifest;
- owner-only state files, advisory locks, and committed-prefix SHA-256 do not
  authenticate state against a malicious same-user process;
- candidate-digest authenticity depends on a trusted artifact authority
  computing the configured value from the intended bytes;
- Protocol v1 schemas enforce shape and bounds, not semantic provenance or
  data-loss prevention for allowed opaque strings; and
- harness/provider availability, confidentiality, persistence, and retention
  are not implied by core or protocol compatibility.

The normative classifications and test scope are in the
[v0.1 threat model](../security/threat-model.md).

## 互換性の規則

- 既存messageのshapeはrelease後に変更しない。新機能は新しい `kind` として追加する
- envelopeや既存payloadの破壊的変更はprotocol versionを上げる
- 既存journal recordの意味を変えない。新しいrecord kindは追加できる。破壊的変更はjournal schema versionを上げ、移行手順を `spec/journal/` に書く
- committed-prefix metadataの意味を変えない。破壊的なstore layout変更はstore metadata versionを上げ、移行またはfail-closed方針を `spec/store/` に書く
- `0.x` の間は最新minorだけをsupportする

## Toolchain

| Tool | 固定 |
|---|---|
| Rust | `rust-toolchain.toml`、`Cargo.toml` の `rust-version` |
| Node.js | `.node-version`、`package.json` の `engines` / `devEngines` |
| npm | `package.json` の `packageManager` |
| cargo-deny | `.cargo-deny-version` (shared by CI, release, security, and xtask) |
| TypeScript / Biome / @types/node | root `package.json` の `devDependencies`（exact）と `package-lock.json` |
| GitHub Actions | commit SHAで固定 |

Node.jsは `24.19.0`（LTS）、npmは `12.0.2` に固定しています。DSH adapterが入る時点で、harness SDKの要求に合わせて再評価します（専用PR）。

## v0.1 supported installation

The supported v0.1 installation form is a reviewed or released SHA source
checkout with tooling pinned by `rust-toolchain.toml`, `.node-version`,
`packageManager`, and `.cargo-deny-version`. After `cargo fetch --locked`,
`npm ci`, and the Rust/TypeScript workspace build, `@aizign/protocol` and
`@aizign/adapter-dsh` resolve through workspace links inside the checkout.

An `@aizign/*` registry install, a standalone adapter `.tgz`, registry
publication, or bundling is not a supported v0.1 distribution. `npm pack
--dry-run` and `cargo package --list` only enumerate file sets; they do not
demonstrate installability or artifact qualification. A future archive or
registry form requires a separate accepted decision covering paired
artifact/bundling and a registry-free clean install.

## Harness

| Harness | Adapter | Supported version | Status |
|---|---|---|---|
| DSH | `@aizign/adapter-dsh` | `0.1.1-rc.2`（`@deepseek-ai/cordis` 4.0.1、`schemastery` 3.18.1） | stable rootはplugin entryのみ。preflight + scope-bound tool +唯一のproduction TypeScript one-shot clientを持ち、repository control-plane用transportはclosed `./experimental/transport` subpath。current v0.1 supportにharness persistence/cold readは含まない。fake harnessに加え、第三者（別harness・別model）によるDSH × Firefoxのlive smokeがpass（2026-08-23、commit `fd0e208`、[Issue #11](https://github.com/TakahisaI/Aizign/issues/11)） |
