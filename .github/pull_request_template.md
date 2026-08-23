## Closes

Closes #

## What this slice does

<!-- 1 PR = 1 reviewable slice。何を変え、何を変えないか -->

## Bounded contexts touched

<!-- 例: crates/aizu-core/src/workflow、adapters/dsh/src/mapping。二つ以上なら理由を書く -->

## Checklist

- [ ] PR titleはConventional Commits形式（`feat(core): ...`）
- [ ] `cargo xtask check` がlocalで通る
- [ ] 挙動 / API / schema / 依存境界の変更はIssueで合意済み
- [ ] crate / package境界、依存方向、protocol、journal、data boundary、retry policy、toolchain、release policyの変更にはADRを追加した（該当しない場合はチェック）
- [ ] 新しいprotocol kind / journal record / error codeは `spec/` と `docs/reference/` に登録した（該当しない場合はチェック）
- [ ] raw prompt、model output、credential、private path、旧repositoryの参照を含まない
- [ ] testは所有contextの近くに置き、守る境界を一度壊して検出できることを確認した
