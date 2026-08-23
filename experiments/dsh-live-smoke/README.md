# DSH live smoke (opt-in)

`@aizu/adapter-dsh` を実際のDSHとFirefoxで動かし、fake harnessで検証済みの往復が実環境でも成立することを確認します。
**通常のtestとCIからは起動しません。** 手順そのもの（profileの準備、login、観測結果）はoperatorのlocal directoryに置き、repositoryには再現可能なscriptだけを置きます。

## 前提

- DSH `0.1.1-rc.2`（`docs/reference/compatibility.md` のpinと一致させる）
- Firefox（Chromium系は対象外）
- `cargo build -p aizu-cli` 済みの `aizu` binary
- `npm ci && npm run build` 済みのworkspace（adapterは `lib/` から読み込まれる）
- 架空のnon-confidentialなassignmentだけを使う

## 観察すること

| 操作 | 期待する `submit_workflow_signal` の結果 |
|---|---|
| `{"kind":"implementation_ready"}` | `{"disposition":"accepted","eventId":...}` |
| 同じ引数をもう一度 | `disposition: duplicate` |
| `{"kind":"blocked","shortErrorCode":"CHANGED"}`（同じeventId） | error `EVENT_CONFLICT` |
| DSHを通常停止 → 再起動 → 同じ引数 | `disposition: duplicate`（journalが正本） |

完了をsessionの消失、idle、通知、browserの表示から推測しないこと。

## 記録してよいもの

- DSH / Firefox / Aizu のversion
- disposition と error code
- `summarize-journal.mjs` の出力（seq、record kind、signal kind、identity）

記録しないもの: prompt、model output、reasoning、terminal全文、環境変数、credential、browser profile、DSH session id。

## Scripts

```sh
# operator patch を生成（stdout）。値はすべてoperatorが与える
node experiments/dsh-live-smoke/make-patch.mjs \
  --binary /abs/path/to/aizu --state /abs/path/to/state \
  --event-id evt-live-1 --workflow-id wf-live --assignment-id as-live --role implementation --revision rev-live-1 \
  > /abs/path/outside/repo/aizu-live.patch.yml

# smoke後に journal を metadata だけで要約
node experiments/dsh-live-smoke/summarize-journal.mjs /abs/path/to/state
```

adapterのplugin configは [`adapters/dsh/README.md`](../../adapters/dsh/README.md#設定) を参照してください。
