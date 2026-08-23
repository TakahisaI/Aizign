# AGENTS.md — @aizu/adapter-dsh

このpackageを編集するときのnavigationと制約です。仕様は [README.md](README.md) と
[docs/development/adding-adapter.md](../../docs/development/adding-adapter.md) を参照してください。

## 読む順

1. [README.md](README.md)
2. [spec/protocol/v1/README.md](../../spec/protocol/v1/README.md) — wire contract
3. `packages/protocol/src/client.ts` — `CoreClient` / `SubmitOutcome` / `UnknownOutcome`
4. `packages/adapter-testkit/README.md` — conformance runnerとfake core
5. 編集対象のdirectory（`core-client/`、`mapping/`、`lifecycle/`）

`crates/` を読む必要はありません。coreの挙動はprotocolとfixtureで決まります。

## 制約

- identity（eventId、workflowId、assignmentId、role、artifactRevision）をtool schema、引数、descriptionに出さない。configで固定する
- DSHのcall id、session id、agent handle、環境変数をpayloadやprocess環境へ渡さない（PATHのみ）
- `unknown` を成功や失敗に縮約しない。`AIZU_OUTCOME_UNKNOWN` を投げ、再送しない
- preflightが失敗したらtoolを登録しない
- SDKからの実行時importは `HarnessError`、schemastery、`ctx.tools.register` にとどめる。Session / persistence / Agentへ広げるときはADR-0010を更新する
- SDKのversionは `package.json` のexact pinと `docs/reference/compatibility.md` を同じPRで更新する
- live smokeの手順・profile・観測結果はrepositoryに置かない（operatorの `op/`）

## 検査

```sh
npm test -w @aizu/adapter-dsh
cargo xtask check
```
