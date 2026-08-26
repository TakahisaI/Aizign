# Governance

## Roles

| Role | 責務 |
|---|---|
| Maintainer | ADRの承認、PRのreviewとmerge、release、security report対応 |
| Contributor | Issue、提案、PR |

現在のmaintainerは [.github/CODEOWNERS](.github/CODEOWNERS) に列挙します。

## 意思決定

- Ordinary changes are agreed in an Issue and reviewed in a PR. Issue-free work
  is limited to the exceptions owned and listed in
  [CONTRIBUTING.md](CONTRIBUTING.md).
- architecture、境界、policyの変更は [ADR](docs/adr/) で決定する
- Accepted ADRはsilent rewriteせず、新しいADRでsupersedeする
- 合意できない場合はmaintainerが決定し、理由をADRまたはIssueに残す

## Merge policy

- default branchは `main`。直接push、force push、branch deletionは禁止
- squash mergeのみ。merge後にhead branchを自動削除
- required checksとconversation resolutionを必須にする
- maintainer自身のPRは、green CIとPR checklistを満たせばself-merge可
- 第二maintainer参加後は、non-author approvalを1件必須にする

## Maintainerの追加

次を満たすcontributorを、既存maintainerの合意でmaintainerに追加します。

- 複数のreviewable sliceをIssue合意からmergeまで通した
- hard invariantsとdata boundaryを理解し、reviewで指摘できる
- security reportの非公開対応に同意する

## Release

releaseの手順とgateは [docs/development/releasing.md](docs/development/releasing.md) に従います。
registryへの公開は、`v0.1` acceptance後に別ADRで有効化するまで行いません。

## Adapterのownership

harness adapterは独立したpackageとして置きますが、repositoryは当面ひとつです。
adapterを別repositoryへ切り出すのは、次がすべて揃った場合だけです（[ADR-0001](docs/adr/0001-start-aizu-as-a-fresh-public-monorepo.md)）。

- Protocol v1が安定している
- coreと独立したrelease cadenceが必要
- 別maintainerがownershipを持つ
- Aizign本体と異なるsecurityまたはdistribution境界を持つ
