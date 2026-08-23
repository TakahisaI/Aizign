# AGENTS.md

このファイルは、LLM agentとcontributorがこのrepositoryを編集するときの **navigationと編集制約** です。
新しい仕様はここに書きません。仕様の正本は [README.md](README.md#documentation-authority) の表に従います。

## まず読むもの

| 作業 | 読む範囲 |
|---|---|
| 全体像 | [docs/architecture/overview.md](docs/architecture/overview.md) |
| どこに何を置くか | [docs/architecture/context-map.md](docs/architecture/context-map.md) |
| 依存してよいもの | [docs/architecture/dependency-rules.md](docs/architecture/dependency-rules.md) |
| coreやjournalへ渡してよいデータ | [docs/architecture/data-boundary.md](docs/architecture/data-boundary.md) |
| 過去の決定とその理由 | [docs/adr/](docs/adr/) |
| 用語 | [docs/reference/glossary.md](docs/reference/glossary.md) |
| 作業の進め方 | [CONTRIBUTING.md](CONTRIBUTING.md) |

各crate / packageには固有の `README.md` があり、`aizu-core`、`aizu-engine`、各adapterには固有の `AGENTS.md` があります。
**編集対象に最も近い `AGENTS.md` が優先します。**

## 編集の原則

- 変更はひとつのbounded contextに閉じる。二つ以上のcontextを跨ぐなら、PR本文に理由を書く。
- `common/`、`utils/`、`shared/`、`AppContext`、`Services`、`Container` のような横断的な置き場を作らない。
- Portは利用側が定義する。外部実装の都合でcore interfaceを設計しない。
- Rustは `pub(crate)` を既定にし、`lib.rs` で意図した型だけを公開する。wildcard re-exportをしない。
- TypeScript packageは `exports` mapをclosedにし、deep importを許さない。
- domain型を直接serializeしない。protocol DTO、journal record、domain型は別物として変換する。
- 既存のprotocol messageやjournal recordのshapeをrelease後に変えない。新機能は新しい `kind` として追加する。
- testは所有contextの近くに置く。rootに巨大なtest directoryを作らない。
- Issue単位の設計文書（`docs/issue-N-design.md`）を作らない。決定はADR、現状はarchitecture docs、作業状況はIssueへ。

## 変更前にADRが必要なもの

crate / package境界、依存方向、protocol shapeまたはversion、journal format、core–adapter接続方式、
新しいruntime dependency、security / data boundary、automatic retry policy、MSRV / Node support policy、
release / compatibility policy。詳細は [CONTRIBUTING.md](CONTRIBUTING.md#adrが必要な変更)。

## Hard invariants

repository全体で守る不変条件です。これを破る変更は、ADRでsupersedeしない限り受け入れません。

1. 自然言語、idle、画面表示を完了の正本にしない。
2. External effectはeffect前にdurable claimする。
3. Effect結果が不明ならblind retryしない。
4. `unknown` を成功または失敗へ推測しない。
5. Evidenceをworkflow、assignment、attempt、candidate revisionへbindingする。
6. Review passだけでintegrationしない。
7. Human authorizationはrevision-boundかつappend-onlyにする。
8. Provider固有identityをcore identityにしない。
9. Restart reconciliationはboundedかつread-onlyにする。
10. Control journalへraw prompt、model output、reasoning、credentialを保存しない。
11. Remote publication、repository visibility変更、force updateを自動実行しない。
12. 同一identity・同一内容はduplicate、同一identity・異内容はconflictにする。

## 検査

PRを出す前に root で次を通します。

```sh
cargo xtask check
```

内訳と個別commandは [docs/development/testing.md](docs/development/testing.md) を参照してください。
live smoke（実harness、browser、provider login）は通常の検査から起動しません。

## 禁止事項

- credential、`.env`、raw prompt、model output、実データをcommitしない。
- private repositoryのURL、private path、個人のhome directoryをrepositoryへ書かない。
- 旧repositoryのsource treeを一括copyしない。採用する契約はAizu側のIssueまたはADRで `Adopt / Reject / Defer` を明示し、testとして書き直す。
- 人の授権なしにremote publication、merge、削除、visibility変更を自動実行しない。
