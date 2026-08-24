# 2026-08-24 initial runtime baseline

このreportは、Issue #57で導入した計測経路と全sweepが一つのrelease binaryで完走することを確認した開発観測です。
QEMU user emulationを含むため、絶対値をperformance budgetやnative Linuxの予測値には使いません。

このartifactはrunner v2で取得した履歴です。
PR review後のrunner v3は、parent exit時刻、concurrency timer、lost-ACK、DSH source、artifact allowlistを修正しました。
そのため、v2のparent timing、concurrency、DSH、canonical scenarioの数値をv3 baselineとして再利用しません。
child handlerとstore stageの開発観測だけを、native run前の参考値として残します。

## Environment

| Item | Value |
|---|---|
| Base commit | `5e3f118a3d9dc50ccda5a2d95048b615c23dc73d` |
| Working tree | Issue #57の実装を含むdirty tree |
| Generated | 2026-08-24T14:37:00.074Z |
| Host | Apple M1 |
| Guest | arm64 Linux 7.0.0-28-generic、4 vCPU |
| Measured binary | `x86_64-unknown-linux-gnu` release profile、QEMU user 10.2.1で実行 |
| Build toolchain | Rust 1.97.1、GNU cross linker |
| Parent runner | Node v24.19.0、arm64 |
| Filesystem | overlayfs |
| Sampling | pointごとに`new_process_new_open` 1回、未記録warmup 1回、`warm_repeated` 5回 |
| Percentile | nearest rank |
| Coverage | runner v2の全6 sweep、396 recorded observations、66 aggregate rows |

runner containerからgitとrustcを参照できなかったため、生artifact内の`commit_sha`と`rust_version`は`unavailable`でした。
上表のbase commitとbuild toolchainは、buildを行ったhostとworktreeで確認した値です。

store stageを分離したrunner v2では、同じhostとguestで`max-payload`と`journal-scale`を再採取しました。
このfollow-up runはtmpfs上で、未記録warmup 1回、warm sample 5回、120 recorded observations、20 aggregate rowsです。
filesystemが異なるため、最初のoverlayfs runとの絶対値比較には使わず、stage内訳と最大長fixtureの確認に使います。

## Journal scale

次のtableは`warm_repeated`だけを集計し、各cellをp50 / p95 / p99 ms（n）で示します。

| Case | Entries | Handler | Parent close（v2旧定義） | Load and decode | Replay | Append and sync |
|---|---:|---:|---:|---:|---:|---:|
| accepted | 0 | 37.723 / 40.873 / 40.873 (5) | 69.485 / 74.349 / 74.349 (5) | 0.818 / 1.060 / 1.060 (5) | 0.035 / 0.038 / 0.038 (5) | 5.087 / 6.365 / 6.365 (5) |
| accepted | 100 | 54.603 / 58.777 / 58.777 (5) | 90.914 / 95.925 / 95.925 (5) | 12.356 / 13.604 / 13.604 (5) | 1.503 / 1.593 / 1.593 (5) | 5.181 / 5.898 / 5.898 (5) |
| accepted | 1,000 | 94.882 / 114.406 / 114.406 (5) | 126.936 / 149.170 / 149.170 (5) | 46.359 / 58.541 / 58.541 (5) | 5.846 / 6.688 / 6.688 (5) | 8.651 / 9.796 / 9.796 (5) |
| accepted | 9,999 | 508.312 / 527.803 / 527.803 (5) | 543.862 / 563.193 / 563.193 (5) | 352.959 / 374.198 / 374.198 (5) | 53.906 / 54.584 / 54.584 (5) | 35.042 / 45.017 / 45.017 (5) |
| duplicate | 10,000 | 478.693 / 513.874 / 513.874 (5) | 510.108 / 549.402 / 549.402 (5) | 356.291 / 391.899 / 391.899 (5) | 55.465 / 58.875 / 58.875 (5) | n/a |
| bound exceeded | 10,000 | 510.374 / 536.432 / 536.432 (5) | 546.547 / 568.940 / 568.940 (5) | 387.247 / 417.887 / 417.887 (5) | 55.420 / 56.783 / 56.783 (5) | 0.078 / 0.085 / 0.085 (5) |
| absent lookup | 10,000 | 441.858 / 525.371 / 525.371 (5) | 473.829 / 575.723 / 575.723 (5) | 336.961 / 380.502 / 380.502 (5) | 55.871 / 87.051 / 87.051 (5) | n/a |

この環境では、journalが大きくなるほどloadとdecodeが支配的になりました。
0 entry acceptedのhandler p50は37.723 msで、process全体のp50は69.485 msだったため、固定のprocess境界にも約31.8 msの差があります。
9,999 entry acceptedではloadとdecodeがhandler p50の約69%を占め、replayも53.906 msまで増えました。

acceptedのappendと`sync_all`は0から100 entryではp50約5 msでしたが、9,999 entryでは35.042 msでした。
この増加にはcommit pointのhashとpublish、emulated syscall、overlayfsが含まれるため、native filesystemでstage別に再確認する必要があります。
duplicateとlookupはappendしない一方で、照合のために同じcommitted prefixをloadしてreplayします。

## Transport（runner v2の履歴）

runner v2はNodeの`close` eventで`spawn_to_exit_ms`を確定していたため、このsectionの値は現行定義と互換ではありません。
runner v3は`exit` eventのtimestampを保存し、response parseだけを`close`まで待ちます。

| Case | Entries | Direct p50 / p95 / p99 ms | TypeScript reference p50 / p95 / p99 ms |
|---|---:|---:|---:|
| accepted | 0 | 68.330 / 76.919 / 76.919 | 67.077 / 68.705 / 68.705 |
| accepted | 100 | 67.566 / 78.111 / 78.111 | 87.950 / 89.203 / 89.203 |
| accepted | 9,999 | 535.839 / 647.366 / 647.366 | 552.523 / 680.746 / 680.746 |
| duplicate | 10,000 | 536.278 / 560.137 / 560.137 | 502.220 / 547.576 / 547.576 |
| absent lookup | 10,000 | 479.442 / 511.619 / 511.619 | 475.592 / 584.880 / 584.880 |

5 sampleのemulated runでは差の向きが揃っていません。
この結果からTypeScript client固有の一定overheadを設定することはできず、native scheduled runの反復が必要です。

## Maximum payload cold boundaries

follow-up runは、識別子を有効な上限の128 bytes、`artifactRef`を256 bytesにして、release binaryの`new_process_new_open`を記録しました。

| Operation | Entries | Outcome | Handler ms | Parent close ms（v2旧定義） | Prefix read ms | Verify hash ms | Decode ms | Replay ms | Publish hash ms |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| submit | 1,000 | accepted | 75.600 | 109.412 | 0.479 | 2.715 | 30.206 | 5.477 | 2.107 |
| submit | 10,000 | rejected `JOURNAL_BOUND_EXCEEDED` | 422.819 | 452.523 | 2.229 | 20.270 | 261.779 | 58.780 | n/a |
| reconcile | 1,000 | accepted | 81.409 | 114.894 | 3.500 | 3.059 | 41.287 | 6.551 | n/a |
| reconcile | 10,000 | accepted | 396.620 | 425.427 | 3.904 | 22.466 | 267.140 | 56.265 | n/a |

最大長payloadでも、10,000-entryのhandlerはcold observationで0.5秒未満でした。
これはQEMUとtmpfs上の値でありnative latencyではありませんが、現在の10秒watchdogへ秒単位の余裕があることは確認できます。

## Committed-prefix attribution

follow-up runのwarm sampleでは、prefix処理をread、verification hash、decode、replayへ分け、accepted submitではpublish用の二度目のwhole-prefix SHA-256も分けました。

| Case | Entries | Load total p50 ms | Read p50 ms | Verify hash p50 ms | Decode p50 ms | Replay p50 ms | Append total p50 ms | Publish hash p50 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| accepted submit | 1,000 | 34.313 | 0.463 | 2.582 | 29.329 | 5.811 | 4.258 | 2.094 |
| accepted submit | 9,999 | 306.353 | 1.611 | 21.921 | 265.726 | 59.944 | 23.222 | 21.077 |
| absent lookup | 1,000 | 33.644 | 2.592 | 2.507 | 28.075 | 5.183 | n/a | n/a |
| absent lookup | 10,000 | 293.130 | 3.936 | 21.516 | 266.508 | 58.708 | n/a | n/a |

9,999-entry acceptedでは、publish用SHA-256のp50 21.077 msがappend stageのp50 23.222 msの約91%を占めました。
1,000 entryでも2.094 msでappend stageの約49%です。
少なくともこのCPU-emulated tmpfs環境では、検証時にhashしたprefixをappend直後にもう一度先頭からhashするcostは無視できません。

後続の最適化候補は、published digestとの照合に成功した時点のvalidated incremental SHA-256 stateをsnapshotと一緒に保持し、appendするlineだけを追加して次のdigestをfinalizeする方法です。
この変更は二度目のwhole-prefix traversalだけを除き、journalとcommit metadataの`sync_all`、lock、unknown semantics、published-prefix boundaryを残せます。
ただし、hasher stateを保持するのはdigest照合成功後に限ること、failure時にsnapshotを再利用しないこと、従来のwhole-prefix hashとdigestが一致することを別Issueで検証する必要があります。
Issue #57ではbaselineの確立に留め、この最適化は実装しません。

## Core watchdog headroom

二つの開発観測で最も遅かったwarm handler p99は、最初のrunの9,999-entry accepted transport pointにおける616.550 msでした。
既定のcore watchdog 10,000 msに対し、9,383.450 ms、約93.8%のheadroomがあります。
QEMU上でもjust-under-timeoutではなく秒単位の余裕があり、現状のboundをperformanceのために変更する根拠はありません。

## Concurrency

runner v2のdifferent-state batchは、timer開始後にfixtureを逐次生成していました。
same-state batchはtimer開始前にfixtureを生成していたため、両modeのthroughputとparallelismは比較できません。
runner v3は全stateをtimer開始前に準備し、境界テストでseed、timer、spawnの順序を固定しました。
同時実行結果は許可されたsemantic outcomeだけを受け付け、summaryはthroughput、`JOURNAL_LOCKED`、想定外件数、error codeを分けて表示します。
このreportにはv2 concurrencyの数値をbaselineとして残しません。

## DSH evidenceとcanonical scenario

runner v2のDSH seriesはin-memory array走査だけを測りながらcold readと表記していました。
lost-ACK seriesも正常responseを受信した後でresult objectを書き換えており、clientの`no_response`経路を通っていませんでした。
runner v3はin-memory scanとdeterministic file-backed readを分離し、benchmark専用proxyが実submit responseを破棄します。
preflightとreconcileはdirect client、submitだけはproxy clientを使います。
clientが`unknown/no_response`を返し、proxy submit一回とdirect reconcile一回だけを実行したことをrunnerがassertします。
proxy counterの検証はscenario全体の計測区間を閉じた後に行います。
scenario aggregateは全体時間、preflight、submit、reconcileを別々の分布として保存します。
このreportにはv2 DSHとcanonical scenarioの数値をbaselineとして残しません。

## Budget candidates

次のmetricとscale pointは、native scheduled runが蓄積した後のbudget候補です。

- `spawn_to_exit_ms` p95を0、100、1,000、上限近傍のjournal classごとに分ける
- `journal_load_decode_ms` p95と`replay_ms` p95を1,000 entryと10,000 entryで追う
- acceptedだけの`append_sync_ms` p95を小規模と上限近傍で分ける
- `committed_prefix_decode_ms`と`publish_prefix_hash_ms`を分け、incremental hasher候補の効果を追う
- canonical scenarioの`aizign_end_to_end_ms` p95に加え、preflight、submit、reconcileのparent p95を別々に追う
- DSH evidenceはevent count別の`harness_cold_read_ms` p95として、journal authorityとは別に扱う

数値thresholdはこのreportでは設定しません。
同一のnative runner条件で複数runを集め、日内変動とGitHub-hosted runnerのnoiseを確認してから候補値と許容幅を決めます。
