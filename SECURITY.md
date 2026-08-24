# Security Policy

## Reporting a vulnerability

脆弱性はGitHubの **Private vulnerability reporting**（repositoryの Security タブ → Report a vulnerability）から報告してください。
public Issueには書かないでください。

報告には次を含めてください。

- 影響を受けるcrate / packageとversion（またはcommit）
- 再現手順と期待される境界
- 実際に観測した挙動

報告にcredential、token、実データ、private path、raw prompt、model outputを貼らないでください。
再現に必要な場合は、架空のnon-confidentialな値へ置き換えてください。

受領確認は7日以内、初期評価は14日以内を目安にします。修正が確定するまで詳細は非公開にします。

## Supported versions

`0.x` の間は最新のminor releaseだけをsupportします。古いreleaseへのbackportは行いません。

## Data boundary

Aizignが扱うデータの境界は [docs/architecture/data-boundary.md](docs/architecture/data-boundary.md) に定義しています。要点は次のとおりです。

- control journalにはraw prompt、model output、reasoning、credential、environmentを保存しない
- provider / harness固有のsession ID、thread IDはadapter内に閉じ、coreのidentityにしない
- adapterのlogはstderrへ出し、stdoutはprotocol response専用にする
- remote publication、repository visibility変更、force updateを自動実行しない

## Repository hygiene

- GitHub Actionsのpermissionは原則 `contents: read`。Actionはcommit SHAで固定
- Fork PRへsecretを渡さない
- 通常CIは外部model、harness live process、browser、provider loginを起動しない
- tracked treeとpackage artifactは `cargo xtask public-audit` でsecretとprivate pathを検査する
