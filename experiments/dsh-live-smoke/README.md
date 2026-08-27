# DSH live smoke (opt-in)

`@aizign/adapter-dsh` を実際のDSHとFirefoxで動かし、fake harnessで検証済みの往復が実環境でも成立することを確認します。
**通常のtestとCIからは起動しません。** 手順そのもの（profileの準備、login、観測結果）はoperatorのlocal directoryに置き、repositoryには再現可能なscriptだけを置きます。

## 責務の分担

公開repositoryだけを読んでも「何を実行し、何を成功と判定するか」が分かる状態にし、個人環境だけをoperator側に置きます。

| Aizign repository（ここ） | Operator側（repositoryの外） |
|---|---|
| exact version（DSH、Firefox、aizign） | 実際のinstall path、profile path |
| parameterizedなscript（patch生成、journal要約） | browser profileの準備、login操作 |
| preflight（`aizign hello`、plugin起動時の `AIZIGN_UNAVAILABLE` / `AIZIGN_INCOMPATIBLE`） | 実行時の環境設定 |
| 成功 / 失敗の判定表（下記）と記録schema（`result.schema.json`） | privateな実測の保管場所 |
| 再現可能なfixture（`spec/conformance`） | local起動のrunbook |

## 実行者

再現性を独立に確かめるため、実装者とは **別のharness・別のmodel** が、固定したcommit SHAと公開文書だけを使って実行します。
会話の文脈や暗黙知を前提にせず、この文書と `adapters/dsh/README.md` で足りない点があれば、それ自体を記録対象の不備とします。

## 前提

- DSH `0.1.1-rc.2`（`docs/reference/compatibility.md` のpinと一致させる）。`dsh plugin` はprofile内でpnpmへ委譲するため、DSH hostの指定versionを使う
- Firefox（Chromium系は対象外）
- `cargo build -p aizign-cli` 済みの `aizign` binary
- `npm ci && npm run build` 済みのworkspace（adapterは `lib/` から読み込まれる）
- `stateDir` は **存在しなければ `aizign` が `0700` で作る**（親directoryは必要）。先に作るなら `mkdir -m 0700`。
  `0700` でない既存directoryは、最初のtool callで `JOURNAL_UNAVAILABLE`（`state directory must be owner-only (mode 0700)`）になる（preflightの `aizign hello` はjournalを開かないので、そこでは検出されない）
- 架空のnon-confidentialなassignmentだけを使う

## DSH profile

`dsh web` は固定の `web` profileのaliasで、`--profile` を受け付けません（`takes none of parent --profile`）。
adapterを入れたprofileでWeb UIを使うには、**専用のprofile**を作り、`@deepseek-ai/dsh-web-app` とadapterの両方をそのprofileに入れます。
どちらも `dsh.bundle` を宣言しているので、`dsh plugin … add` で入れると `dsh.profile.bundles` に自動で加わります。

```sh
# profile名と path はoperatorが決める。新規profileのworkspace rootへ -w で追加し、adapterは workspace の adapters/dsh を link する
dsh plugin --profile <name> add -w --allow-build=koffi @deepseek-ai/dsh-web-app@0.1.1-rc.2 'link:/abs/path/to/adapters/dsh'

# 合成後の tree を確認: aizign-workflow-signal が disabled: false と config 付きで現れる
dsh --profile <name> --patch /abs/path/outside/repo/aizign-live.patch.yml --dump-config

# 起動（launcher の flag が先、以降は web app の引数）
dsh --profile <name> --patch /abs/path/outside/repo/aizign-live.patch.yml
```

adapterの [`cordis.patch.yml`](../../adapters/dsh/cordis.patch.yml) はbundle層で entry `aizign-workflow-signal` を `disabled: true` で挿入します。
operator patch（`make-patch.mjs` の出力）はその entry を **id で上書き**します。同じidを `insert` で再挿入すると `duplicate loader entry id` で起動しません。

## 観察すること

| 操作 | 期待する `submit_workflow_signal` の結果 |
|---|---|
| `{"kind":"implementation_ready"}` | `{"disposition":"accepted","eventId":...}` |
| 同じ引数をもう一度 | `disposition: duplicate` |
| `{"kind":"blocked","shortErrorCode":"CHANGED"}`（同じeventId） | error `EVENT_CONFLICT` |
| identityを引数に入れる（例 `{"kind":"implementation_ready","eventId":"…"}`） | error `INVALID_SIGNAL`（adapterの `decodeArgs` が **spawn前** に拒否。coreは起動せず、journalは変わらない） |
| DSHを通常停止 → 再起動 → 同じ引数 | `disposition: duplicate`（journalが正本） |

`INVALID_SIGNAL` の行は「agentがidentityを知らない」ことの確認です。tool schemaにidentityは無いので、modelがschema違反を避けて呼ばない場合は、
`observed` に `NOT_CALLED` と書き、`note` に状況を残してください。roleに無い `kind`（implementationで `review_passed` など）も同じ経路で `INVALID_SIGNAL` になります。

完了をsessionの消失、idle、通知、browserの表示から推測しないこと。

## DSH 0.1.1-rc.2 で観測された注意点

初回の第三者実行（2026-08-23）で、Aizignの契約ではないがoperatorが躓いた点です。DSH側の挙動なので、versionが変われば再確認してください。

- **approval policy `ask`**: 承認に応えられる状態（browser pageを開いたまま）でturnを実行すること。応答者が居ないとtool callは `interrupted` になり、UIのerror文言からは原因が分からない
- **model選択**: 「Select model」→「Model」行→一覧の2段階。1段階目には現在のmodelしか出ない
- `dsh web` はcustom profileでは使えない（上記「DSH profile」）

## 記録してよいもの

- DSH / Firefox / Aizign のversion
- disposition と error code
- `summarize-journal.mjs` の出力（seq、record kind、signal kind、identity）

記録しないもの: prompt、model output、reasoning、terminal全文、環境変数、credential、browser profile、DSH session id。

## 記録形式

結果は [`result.schema.json`](result.schema.json) に従うJSONで記録します（metadata-only）。`summarize-journal.mjs --json` の出力を `journal` に貼れます。

```json
{
  "commit": "<git SHA>",
  "date": "2026-08-23",
  "versions": { "dsh": "0.1.1-rc.2", "firefox": "…", "aizign": "0.1.0" },
  "executor": "<harness / model>",
  "steps": [
    { "step": "submit implementation_ready", "expected": "accepted", "observed": "accepted" },
    { "step": "resubmit", "expected": "duplicate", "observed": "duplicate" },
    { "step": "conflicting blocked", "expected": "EVENT_CONFLICT", "observed": "EVENT_CONFLICT" },
    { "step": "identity in tool args", "expected": "INVALID_SIGNAL", "observed": "INVALID_SIGNAL" },
    { "step": "restart and resubmit", "expected": "duplicate", "observed": "duplicate" }
  ],
  "journal": { "records": 1, "kinds": ["implementation_ready"] },
  "verdict": "pass"
}
```

実行結果はIssueにコメントとして残します（初回: [#11](https://github.com/TakahisaI/Aizign/issues/11)、verdict `pass`。文書不足の起票: [#29](https://github.com/TakahisaI/Aizign/issues/29)）。

## Scripts

```sh
# operator patch を生成（stdout）。値はすべてoperatorが与える。bundle層の entry を id で上書きする形で出る
node experiments/dsh-live-smoke/make-patch.mjs \
  --binary /abs/path/to/aizign --state /abs/path/to/state \
  --event-id evt-live-1 --workflow-id wf-live --assignment-id as-live --attempt-id attempt-live-1 \
  --role implementation --revision rev-live-1 \
  --candidate-digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  > /abs/path/outside/repo/aizign-live.patch.yml

# smoke後に journal を metadata だけで要約（--json で result.schema.json の journal 形式）
node experiments/dsh-live-smoke/summarize-journal.mjs /abs/path/to/state
node experiments/dsh-live-smoke/summarize-journal.mjs --json /abs/path/to/state
```

adapterのplugin configは [`adapters/dsh/README.md`](../../adapters/dsh/README.md#設定) を参照してください。
scriptの回帰testは `npm run test:experiments`（root の `npm test` に含まれる）で走ります。
