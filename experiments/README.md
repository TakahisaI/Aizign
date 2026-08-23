# experiments

opt-inのlive検証に使う **再現可能なscriptだけ** を置きます。通常の `cargo xtask check` / CIからは起動しません。

- operator固有の手順（profileの準備、login、観測結果）はrepositoryに置きません。operatorのlocalな運用directoryに置きます
- scriptは架空のnon-confidentialな値だけを扱い、本文・credential・実pathを出力しません
- live smokeの成否を通常releaseのrequired checkにしません

| Directory | 内容 |
|---|---|
| [`dsh-live-smoke/`](dsh-live-smoke/README.md) | DSH / Firefoxで `@aizu/adapter-dsh` を実際に動かすためのpatch生成とjournal要約 |
