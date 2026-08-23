# Adding a harness adapter

新しいharness adapterを追加するとき、読む必要があるのは次だけです。
既存adapter（DSHのSession実装やbrowser smoke）を読む必要はありません。

| 読む | 内容 |
|---|---|
| `spec/protocol/v1/` | wire contract。envelope、kind、schema、example |
| `packages/protocol/` | `@aizu/protocol`。envelopeの型、validator、`hello` |
| `packages/adapter-testkit/` | fake core process、conformance runner |
| この文書 | 契約と境界 |
| `adapters/<your-harness>/` | 自分の実装 |

## 最小契約

すべてのadapterは同じ最小契約を実装します。能力差は `capabilities` で明示し、すべてのharnessに同一能力を強制しません。

```text
connect                     harnessへ接続し、health / compatibilityを確認する
capabilities                このadapterが提供できる操作を宣言する
submit / observe evidence   native eventをstructured evidenceへ変換し、coreへ提出する
dispatch effect intent      coreのeffect intentをharness操作へ変換する。effect前にclaim済みであること
interrupt                   進行中のattemptを中断する
release                     harness側resource（session、agent）を解放する
reconcile                   restart後にbounded read-onlyで状態を照合する
health / compatibility      harness version、protocol version、capabilityの照合
```

## 境界

adapterだけが保持してよいもの、coreへ渡してよいものは [data-boundary.md](../architecture/data-boundary.md) に従います。要点:

- harness session IDをcore identityにしない。adapter-ownedなopaque handleかbounded evidenceへ変換する
- coreへはstable identity、bounded opaque handle、digest、structured evidence、disposition、short error code、capabilityだけを渡す
- effect結果が不明なら `unknown` を返す。blind retryしない
- 完了の正本はdurable evidence。自然言語、idle、画面表示を使わない

## Package

```text
adapters/<harness>/
├── package.json        name: @aizu/adapter-<harness>, private / publish disabled（当面）
├── README.md           Responsibility、Non-responsibility、Inputs、Outputs、Hard invariants、Allowed dependencies、Test command、関連ADR
├── AGENTS.md           navigationと編集制約だけ
├── src/
│   ├── index.ts        closed exports の入口
│   ├── config.ts
│   ├── core-client/    aizu binaryの起動、envelope送受信
│   ├── mapping/        native event <-> protocol DTO
│   ├── evidence/       harness persistenceのcold read、binding digest
│   └── lifecycle/      connect / interrupt / release / reconcile
└── test/
    ├── unit/
    └── conformance/    @aizu/adapter-testkit を使う
```

- harness SDKはexact versionで固定する
- `exports` mapはclosed。deep importを許さない
- `@aizu/protocol` 以外のworkspace packageにruntime依存しない
- 通常testはfake harnessとfake core processで完結させ、live smokeは `experiments/` のopt-inだけにする

## 手順

1. Issue（template: Adapter proposal）で、harness、capabilities、データ境界、live smokeの方法を合意する
2. `docs/architecture/dependency-rules.md` の表にpackageを追加する
3. `packages/adapter-testkit` のconformanceを通す
4. `docs/reference/compatibility.md` にサポートするharness versionを追記する
