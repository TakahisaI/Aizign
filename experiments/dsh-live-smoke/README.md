# DSH live smoke (opt-in)

`@aizu/adapter-dsh` を実際のDSHとFirefoxで動かし、fake harnessで検証済みの往復が実環境でも成立することを確認します。
**通常のtestとCIからは起動しません。** 手順そのもの（profileの準備、login、観測結果）はoperatorのlocal directoryに置き、repositoryには再現可能なscriptだけを置きます。

## 責務の分担

公開repositoryだけを読んでも「何を実行し、何を成功と判定するか」が分かる状態にし、個人環境だけをoperator側に置きます。

| Aizu repository（ここ） | Operator側（repositoryの外） |
|---|---|
| exact version（DSH、Firefox、aizu） | 実際のinstall path、profile path |
| parameterizedなscript（patch生成、journal要約） | browser profileの準備、login操作 |
| preflight（`aizu hello`、plugin起動時の `AIZU_UNAVAILABLE` / `AIZU_INCOMPATIBLE`） | 実行時の環境設定 |
| 成功 / 失敗の判定表（下記）と記録schema（`result.schema.json`） | privateな実測の保管場所 |
| 再現可能なfixture（`spec/conformance`） | local起動のrunbook |

## 実行者

再現性を独立に確かめるため、実装者とは **別のharness・別のmodel** が、固定したcommit SHAと公開文書だけを使って実行します。
会話の文脈や暗黙知を前提にせず、この文書と `adapters/dsh/README.md` で足りない点があれば、それ自体を記録対象の不備とします。

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

## 記録形式

結果は [`result.schema.json`](result.schema.json) に従うJSONで記録します（metadata-only）。`summarize-journal.mjs --json` の出力を `journal` に貼れます。

```json
{
  "commit": "<git SHA>",
  "date": "2026-08-23",
  "versions": { "dsh": "0.1.1-rc.2", "firefox": "…", "aizu": "0.1.0" },
  "executor": "<harness / model>",
  "steps": [
    { "step": "submit implementation_ready", "expected": "accepted", "observed": "accepted" },
    { "step": "resubmit", "expected": "duplicate", "observed": "duplicate" },
    { "step": "conflicting blocked", "expected": "EVENT_CONFLICT", "observed": "EVENT_CONFLICT" },
    { "step": "restart and resubmit", "expected": "duplicate", "observed": "duplicate" }
  ],
  "journal": { "records": 1, "kinds": ["implementation_ready"] },
  "verdict": "pass"
}
```

## Scripts

```sh
# operator patch を生成（stdout）。値はすべてoperatorが与える
node experiments/dsh-live-smoke/make-patch.mjs \
  --binary /abs/path/to/aizu --state /abs/path/to/state \
  --event-id evt-live-1 --workflow-id wf-live --assignment-id as-live --role implementation --revision rev-live-1 \
  > /abs/path/outside/repo/aizu-live.patch.yml

# smoke後に journal を metadata だけで要約（--json で result.schema.json の journal 形式）
node experiments/dsh-live-smoke/summarize-journal.mjs /abs/path/to/state
node experiments/dsh-live-smoke/summarize-journal.mjs --json /abs/path/to/state
```

adapterのplugin configは [`adapters/dsh/README.md`](../../adapters/dsh/README.md#設定) を参照してください。
