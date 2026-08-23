# ADR-0010: Harness SDK dependencies and the Node support policy

- Status: Accepted
- Date: 2026-08-23
- Related: ADR-0001, ADR-0003, ADR-0008

## Context

最初のharness adapter `@aizu/adapter-dsh` は、DSHのSDK（`@deepseek-ai/dsh-tools`、`dsh-llm`、`cordis`、`schemastery`）を必要とする。
DSHはdeveloper previewで、rc版ごとに破壊的変更がある。SDKはnative addonを含むpackageに依存することがあり、install scriptが動く。
Aizuのcoreはこれらに一切依存しない（ADR-0002）が、adapter packageはSDKなしにはDSHのtoolを登録できない。

## Decision

- harness SDKは **adapter packageだけ** が依存する。`peerDependencies` と `devDependencies` の両方に **exact version** で置き、`^` / `~` を使わない。
  `@aizu/protocol` と `@aizu/adapter-testkit` はSDKを知らない。
- 最初のpinは DSH `0.1.1-rc.2`（`@deepseek-ai/cordis` は `4.0.1`、`@deepseek-ai/schemastery` は `3.18.1`）。
  `package.json` の `engines.dsh` にも同じ値を書き、`docs/reference/compatibility.md` のHarness表が正本。
- SDKの更新は専用PRで行い、fake harness / fake coreによるtest、`cargo xtask check`、そして `op/` 側のlive smoke（opt-in）を再実行してから採用する。
- root `.npmrc` に `ignore-scripts=true` を置く。preview SDKのinstall scriptを通常のinstallで実行しない。
  Aizu自身のpackage scriptは `npm run` で明示的に起動するので影響を受けない。
- Node.jsは **24 LTS**（`.node-version` = `24.19.0`、npm `12.0.2`）に固定する。harness SDKの要求範囲（`>=24 <25`）と一致させるためで、更新は専用PR（ADR-0008）。
  CIはsetup-nodeをcheckoutの前に実行し、runner同梱のnpmが `devEngines` に拒否されないようにする。
- adapterがSDKから実行時に使うのは、tool登録（`ctx.tools.register`）、`HarnessError`、`Config` schema（schemastery）だけにとどめる。
  DSH Session、persistence、Agent lifecycleへの依存は、それを必要とするsliceでこのADRをsupersedeして追加する。

## Consequences

### Positive

- SDKの破壊的変更の影響範囲が `adapters/dsh` に閉じる
- coreとprotocolのCIは引き続きNode / DSHなしで成立し、TypeScript jobもnetworkなしの fake で完結する

### Negative / Risks

- exact pinのため、SDKの修正版を取り込むには毎回PRが要る。preview段階では意図した摩擦
- `ignore-scripts` により、install scriptを要するnative addonを持つSDKは動かない可能性がある。adapterのtestはSDKのruntimeを起動しないので現時点では問題にならず、live smokeで確認する

### Follow-up

- live smoke手順はrepositoryに置かず、operatorの `op/` に置く（repositoryには再現可能なscriptだけ）
- DSH Session persistenceからのevidence cold readを入れる時点で、このADRを更新する

## Alternatives considered

- **SDKをrange指定にする** — preview SDKでは動いた組み合わせを特定できなくなる
- **SDKをroot `package.json` に置く** — protocolやtestkitまでSDKに引きずられ、「adapterを消してもcoreとprotocolが成立する」性質を失う
