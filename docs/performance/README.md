# Performance reports

このdirectoryは、review済みのruntime performance reportを保存します。
machine-readableな生sampleは大きくなるため、scheduledまたはmanual workflowのartifactを正本とし、ここには環境、設定、代表値、解釈を残します。

初回の開発観測は[2026-08-24-initial-baseline.md](2026-08-24-initial-baseline.md)です。
runnerの契約と再実行手順は[benchmarks/runtime/README.md](../../benchmarks/runtime/README.md)を参照してください。

reportを追加するときは、次を必ず記録します。

- 対象commitとdirty treeの有無
- OS、architecture、CPU、filesystem、Rust、Node、build profile
- warmup数、sample数、percentile方式
- core watchdogとの比較とheadroom
- `result.json`と`summary.md`を取得したworkflow run
- 数値から読める傾向と、環境差やsample数による解釈の限界
- budget候補を変更する場合は、その根拠となる複数run

単一runの値をそのままCI thresholdにしません。
budgetを導入する変更は、安定したnative runnerで複数回採取し、noise allowanceとregression時の運用を別Issueで合意してから行います。
