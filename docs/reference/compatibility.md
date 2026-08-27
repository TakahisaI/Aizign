# Compatibility

## Version boundaries

| Version | 現在 | 管理 |
|---|---|---|
| Aizign package version | `0.1.0`（未release） | 全artifact lockstep。`Cargo.toml`、各 `package.json` |
| Protocol version | `1`（`aizign-protocol` が実装。`hello`、`workflow.signal.submit`、`workflow.signal.reconcile`） | `spec/protocol/v1/`。envelopeの `version` |
| Journal schema version | `1`（`aizign-store-jsonl` が実装） | `spec/journal/v1/`。recordの `schemaVersion` |
| Store metadata version | `1`（`aizign-store-jsonl` が実装） | `spec/store/v1/`。commit documentの `storeVersion` |

adapterはpackage versionの完全一致ではなく、`hello` で得たprotocol versionとcapabilityで互換性を判定します
（[ADR-0003](../adr/0003-use-a-versioned-ndjson-process-boundary.md)、[ADR-0008](../adr/0008-use-lockstep-artifact-versions-before-1-0.md)）。
初期のcommitted-prefix JSONL storeは `x86_64-unknown-linux-gnu` だけが検証済みで、x32を含む別ABIや別architecture / libcのLinuxなど、その他のbuildはsubmit / reconcile capabilityをadvertiseしません。
x32は、64-bit targetと誤認しないことをCIでcross-compileするnegative boundaryに限定し、runtime support、release artifact、support claimは提供しません。
同じstate directoryを旧binaryで開くdowngradeはunsupportedであり、技術的には防止していません。旧binaryがcommit metadataを無視できるため、operatorは別のstate directoryを使用する必要があります。

## Provisional timing evidence

Opt-in timing is internal, provisional operational evidence. It is not part of
Protocol v1, package compatibility, workflow authority, or a stable public
schema. In particular, the child timing record's current `schema_version: 1`
is only an internal producer/consumer guard. It carries no external stability
or migration promise.

The existing child timing source and DSH-owned provisional parent/evidence
timing APIs remain available, but their observations are source-qualified. A
child runtime observation and a parent transport observation must not be
interpreted as one universal semantic outcome. Process, preflight, and parent
timing are not Protocol package compatibility; repository consumers reach them
only through the closed DSH experimental subpaths. The
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
| TypeScript / Biome / @types/node | root `package.json` の `devDependencies`（exact）と `package-lock.json` |
| GitHub Actions | commit SHAで固定 |

Node.jsは `24.19.0`（LTS）、npmは `12.0.2` に固定しています。DSH adapterが入る時点で、harness SDKの要求に合わせて再評価します（専用PR）。

## Harness

| Harness | Adapter | Supported version | Status |
|---|---|---|---|
| DSH | `@aizign/adapter-dsh` | `0.1.1-rc.2`（`@deepseek-ai/cordis` 4.0.1、`schemastery` 3.18.1） | stable rootはplugin entryのみ。preflight + scope-bound tool +唯一のproduction TypeScript one-shot clientを持ち、repository control-plane用transport/evidenceはclosed experimental subpath。fake harnessに加え、第三者（別harness・別model）によるDSH × Firefoxのlive smokeがpass（2026-08-23、commit `fd0e208`、[Issue #11](https://github.com/TakahisaI/Aizign/issues/11)） |
