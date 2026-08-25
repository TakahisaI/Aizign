# Runtime performance baseline

The performance runner uses the release-profile `aizign` binary and TypeScript clients. Baseline mode produces full manual/scheduled observations. PR-smoke mode uses a smaller matrix and generous absolute ceilings for gross-regression detection.

## 実行環境

storage capabilityを検証済みの`x86_64-unknown-linux-gnu` binaryが必要です。
macOSなどの未検証targetでは`aizign`がsubmitとreconcileをadvertiseしないため、runnerはstateへ触れる前に終了します。
通常はGitHub Actionsの`Performance baseline`をmanual dispatchするか、x86_64 GNU/Linux上で次を実行します。

```sh
npm ci --no-audit --no-fund
cargo fetch --locked
cargo xtask performance-baseline
```

短い確認ではsweep、warmup、sample数を絞れます。

```sh
cargo xtask performance-baseline \
  --sweeps journal-scale,scenarios \
  --warmup 1 \
  --samples 5 \
  --output-dir target/performance-baseline-smoke
```

`performance-baseline`はTypeScript packageとrelease binaryをbuildしてからrunnerを起動します。
生成物は既定で`target/performance-baseline/result.json`と`target/performance-baseline/summary.md`へ書きます。

## PR performance smoke

The Linux-only PR workflow runs:

```sh
cargo xtask performance-smoke
```

It builds the same release binary and clients, then writes `target/performance-smoke/result.json` and `summary.md`. The matrix contains accepted submit at 0 / 100 / 9,999 entries, duplicate at 1 / 100 / 10,000, new-event `JOURNAL_BOUND_EXCEEDED` at 10,000, absent lookup at 0 / 100 / 10,000, same-state and different-state submit concurrency 1 / 2, and both canonical scenarios. It runs one warmup and exactly three recorded warm samples; it compares the maximum sample with an absolute ceiling and makes no p99 claim. `performance-smoke` accepts no runner options so a PR cannot silently change these boundaries.

The initial workflow is informational because it is not a required branch-protection check. A smoke failure remains a visible failed check; it is not converted to green. The workflow still uploads diagnostics. Ceiling failures retain the full result and identify the same raw max sample, including its stages and scenario/concurrency operations. Machine-readable attribution separates `stages_ms` from `stages_us`, and the human report renders each with its actual unit. The initial release-binary `hello` verification shares the 60-second operation guard and the failure-manifest path. Timeout, spawn, capability, transport, malformed timing, or semantic failures write metadata-only `status.json` and a failure `summary.md` before exiting nonzero; they are never converted into valid performance samples. Promotion criteria and the three native reference runs are documented in [the performance budget report](../../docs/performance/2026-08-25-performance-budgets.md).

The evaluator requires the exact profile, warmup, sample count, ordered sweep list, 23 aggregate identities, 33 unique budget IDs, one aggregate per identity, and three raw metric values per budget. A missing timing, duplicate aggregate, partial matrix, or noncanonical direct-runner configuration cannot produce `PASS`.

## 計測区間

child側の計測は`AIZIGN_TIMING_JSON=1`でopt inします。
`aizign handle`は通常のlogに加え、`aizign_timing:`で始まるmetadata-only JSONをstderrへ一行出力します。
opt inしていない通常経路は追加のstage clock、observer、journal statを実行せず、非observed engine APIを使います。
未到達のstageは0ではなくfield自体を省略します。

| Field | 区間 |
|---|---|
| `request_read_ms` | stdinの読み取り開始から、one-frame検査を含む読み取り完了まで |
| `decode_ms` | request frameのdecode開始から完了まで |
| `journal_open_ms` | submit用writerまたはreconcile用readerのopen |
| `journal_physical_bytes` | open後にstatしたjournal file全体の長さ。未公開tailを含み得るためcommitted bytesとは呼ばない |
| `journal_entries` | committed journalをloadしてdecodeしたentry数 |
| `journal_load_decode_ms` | committed prefixのload、検証、record decode |
| `committed_prefix_read_ms` | commit metadataの読み取りと、公開済みprefixのexact read |
| `committed_prefix_hash_ms` | 読み取ったprefixのSHA-256をpublished digestと照合する計算 |
| `committed_prefix_decode_ms` | 検証済みprefixのUTF-8検査とjournal record decode |
| `replay_ms` | decoded eventをstateへ順に適用する時間 |
| `decide_us` | submitのpure decision、またはreconcileのpure classification |
| `append_sync_ms` | submitでdecision eventを書き、journalとcommit metadataへ`sync_all`を行い、commit pointをpublishする試行 |
| `publish_prefix_hash_ms` | 新しいcommit pointへ記録するSHA-256のため、追加後のprefix全体をhashする計算 |
| `response_encode_ms` | protocol responseのencode |
| `response_write_ms` | stdoutへのresponse frame書き込みとflush |
| `handler_total_ms` | `handle`がworkerを起動する直前からresponse flushが終わるまで |
| `outcome` | `accepted`、`duplicate`、`conflict`、`rejected`、`absent`、`unknown`などのsemantic outcome |
| `error_code` | error responseに含まれるstable code |
| `operation_kind` | `hello`、`workflow.signal.submit`、`workflow.signal.reconcile`、`unknown`の有限集合。decode前の入力文字列は転記しない |

parent側は`CoreClientConfig.timingSink`でopt inします。
`spawn_to_exit_ms`はspawn呼び出しからNodeのchild `exit` eventまで、`response_first_byte_ms`は最初のstdout byteまでを測ります。
CLIは一つのresponse frameをまとめて書くため、first byteはstreaming progressではなくresponse-readyの近似です。
DSH preflightは`preflight_ms`、evidence cold readは`harness_cold_read_ms`と`events_returned`を別のsinkへ通知します。

どのsinkにもrequest ID、event ID、path、本文、credentialを渡しません。
同期throwと非同期Promise rejectionを含むsinkの失敗、およびchild timingのencode失敗はworkflow結果を変えません。
APIが`unknown`を返す場合、診断codeが`EVENT_CONFLICT`でもtiming outcomeは`unknown`のままです。
公開TypeScript APIも`TimingOutcome`とsource固有のunknown reason unionを使い、timing vocabularyを型として閉じます。

## Sweep

runnerは一つの大きな直積を作らず、問いごとにfixtureを限定します。

| Sweep | 問い |
|---|---|
| `journal-scale` | accepted、duplicate、bound exceeded、absent lookupがjournal規模でどう変わるか |
| `outcomes` | submitとreconcileの各semantic outcomeでstage構成がどう違うか |
| `transport` | 同じfixtureでdirect Node runnerと`ReferenceOneShotClient`のparent観測がどう違うか |
| `max-payload` | 128-byte識別子と256-byte `artifactRef`を使う1,000 / 10,000-entryのsubmitとreconcile |
| `concurrency` | 同じstate directoryと独立state directoryで、同時実行数1、2、4、8がどう振る舞うか |
| `dsh` | 100、1,000、10,000 eventのin-memory evidence scanとdeterministic file-backed read |
| `scenarios` | reference clientによるassignment submitと、実際のlost acknowledgement後の明示的なreconcile |

accepted fixtureはjournal上限10,000の一つ手前まで、duplicate fixtureは照合対象を含む1 entry以上だけを生成します。
bound exceededは10,000 entryから新規submitし、lookupはread-onlyのまま0から10,000 entryを走査します。
fixture生成時間は計測に含みません。

`max-payload`は`repair_submitted` signalを使い、識別子の上限128 bytesと`artifactRef`の上限256 bytesを満たす有効なrequestを生成します。
1,000-entryのsubmitはaccepted、10,000-entryのsubmitは`JOURNAL_BOUND_EXCEEDED`、1,000 / 10,000-entryのreconcileはseed済みtargetに対するacceptedです。
各pointの最初の`new_process_new_open` observationがreview follow-upで指定されたrelease-binary cold境界です。

同じstate directoryへのsubmitはqueueもretryもせず、`JOURNAL_LOCKED`をそのまま数えます。
same-stateとdifferent-stateのfixtureは、どちらも共通batch timerを開始する前にすべて生成します。
runnerはchildの開始barrierを設けないため、batch値には`Promise.all`でspawnを順に発行する短いずれが残ります。
concurrency sampleのfixture規模は`journal_entries_before_batch`で表します。
same-state submitは`accepted`または`JOURNAL_LOCKED`だけを許可し、最低一件の`accepted`を要求します。
different-state submitは全件`accepted`、reconcileは両modeとも全件`absent`を要求し、それ以外の結果ではartifactを保存せずrunを失敗させます。
summaryはbatch latency、成功throughput、accepted数、`JOURNAL_LOCKED`数、想定外件数、error codeを専用tableへ出力します。

lost acknowledgement scenarioは、同じstate directoryを使う二つの`ReferenceOneShotClient` instanceを用意します。
preflightとreconcileは実binaryへ直接接続し、submitだけをbenchmark専用proxyへ接続します。
proxyは実binaryによるdurable appendとresponse生成を完了させてからsubmitのstdout frameだけを破棄します。
runnerはclientが`unknown/no_response`を返したこと、proxy経由のsubmitが一回だけであること、direct clientから一度だけreconcileして`accepted`になることをassertします。
scenario全体のtimerはreconcile完了時に閉じ、その後でproxy invocation counterを検証します。

DSH sweepの`in_memory_scan`はsource I/Oを含まず、evidence classificationだけを測ります。
`file_backed_read`は各sampleの計測前に生成したJSON fileを`readFrom()`内で読み取り、file readとJSON decodeを含めます。
後者もDSH session databaseそのものではないため、実harness storageのlatencyとは区別します。

`rust_direct` transportもbuilt `@aizign/protocol`のone-frame抽出、response decode、request ID、operation kind、event IDの相関検査を通します。
responseなし、malformed response、timeout、相関不一致はtransport unknownとして扱います。
現在のmatrixはすべて`correlated_response`を要求するため、transport unknownは期待outcomeやerror codeと一致してもrunを失敗させます。
raw sampleは`transport_kind`を保存し、相関済みerror responseがsemantic unknownを返した場合もchild timingを必須とします。

direct runnerのstdoutはprotocol frame上限まで、stderrはtimingと診断用の256 KiBまでBufferとして保持します。
lost-ACK proxyもchild stdoutを同じprotocol上限で打ち切ります。
上限超過時はchildを停止し、正常なbaselineまたは意図した`no_response`として保存しません。

## Sampling

各pointは最初に`new_process_new_open`を一回記録し、指定回数の未記録warmup後に`warm_repeated`を採取します。
どのphaseもprocessとstore openは毎回新規です。
ここでいうwarmはOS page cacheの状態を保証せず、runner、toolchain、filesystemを含む実行環境が先行実行を経験したことだけを表します。
GitHub-hosted runnerでtrue cold OS page cacheを主張しません。

aggregateは`warm_repeated`だけからnearest-rankのp50、p95、p99を計算し、metricごとのsample数も保存します。PR smokeのmachine schemaは共通aggregateを保持しますが、3 sampleのhuman summaryとwatchdog比較は`median / max`だけを表示し、p95/p99を性能上の主張として扱いません。
canonical scenarioはscenario全体の`aizign_end_to_end_ms`と、`hello`、`preflight`、`submit`、`submit_lost_ack`、`lookup`のoperation別分布を分離します。
submitとreconcileのparent latencyを一つの分布へ混ぜません。
生の`new_process_new_open` observationとwarm sampleは`result.json`に残ります。
summaryとmachine-readable resultは、全warm aggregateで最も遅い`handler_total_ms`を既定10,000 ms watchdogと比較し、残りのheadroomを明示します。full baselineはp99、PR smokeは3 sampleのmaxを使います。

## Artifactと更新手順

`result.json`はmachine-readableなenvironment、GitHub runner image version、timeout設定、aggregate、生sampleを持ちます。PR smokeの予算根拠は[versioned native baseline manifest](native-baseline-v3.json)から読み、run ID、runner/image version、CPU、result/summary SHA-256、各budgetの最大native p95を固定します。
`summary.md`は同じaggregateをレビュー用tableへ変換します。
runnerはchild、parent、DSH timingごとにexact-key allowlistを検査し、未登録fieldが一つでもあればartifactを保存しません。
timingのschema version、時間値、byte数、entry数、event数も型と範囲を検査します。
時間値は有限の非負数、countは非負のsafe integerだけを許可します。
direct transportの`transport_kind`も`correlated_response`または`unknown`だけを許可します。
private filesystem pathとidentity keyの検査も重ねます。

The scheduled baseline uses fixed `ubuntu-24.04` every Wednesday and on manual dispatch, retains both files for 30 days, and does not run for pull requests. The separate PR smoke also uses `ubuntu-24.04`, retains reports for 14 days, and is informational during its initial observation period.

reviewed baselineを更新するときは、同じcommitのartifact二点を確認し、environmentとsample設定を記録した解釈だけを`docs/performance/`へ追加します。
Issue #57 closed after the first native runner v3 artifact was reviewed. Issue #58 records multiple comparable native runs before introducing the provisional smoke ceilings.
環境が異なるrunの絶対値を直接比較せず、同じ環境内のjournal規模、outcome、transport、concurrencyの傾向を先に確認します。
