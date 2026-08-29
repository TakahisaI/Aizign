# Aizign journal schema v1

Journal record schema v1 remains current and unchanged. Its current/target
physical publication owner is store metadata v2 under
[`../../store/v2/`](../../store/v2/README.md). Store v1 remains historical
compatibility-rejection material, while the production runtime continues to
implement v1 until the ordered Issue #81 S2 migration. This document does not
claim that S2 is already implemented.

control journalのdurable format。**metadata-only、append-only**（ADR-0007）。初期実装はJSONL（`aizign-store-jsonl`）。

```text
<state dir>/            owner-only（0700）
├── workflow.jsonl      1行 = 1 record。owner-only（0600）
├── workflow.lock       writer ownershipのadvisory lock。owner-only（0600）
├── workflow.commit.json writerが公開したstore v2 committed prefix。owner-only（0600）
└── workflow.publish.json PREPARED/CLEAN publication witness。owner-only（0600）
```

両JSON documentはjournal recordではなく、独立したstore metadata v2である。
closed schema、generation、publication、reader authorityの正本は
[`../../store/v2/`](../../store/v2/README.md)。以下の読み書き節に残るv1
commit-point説明は、S2までのruntime debtを説明するもので、target authority
ではない。

## Record

| Field | 型 | 意味 |
|---|---|---|
| `schemaVersion` | `1` | このschemaのversion。package versionと独立 |
| `seq` | integer `1..=10000` | storeが付与する連番。欠番・逆順は `JOURNAL_CORRUPT` |
| `at` | integer | shellが与えたUnix秒。`2020-01-01` 〜 `2100-01-01` の範囲 |
| `kind` | `"workflow.signal.accepted"` | record kind。新しいkindは追加できるが既存の意味は変えない |
| `signal` | object | 受理されたstructured signal（closed。attemptとcandidate pairをdurableに含む。protocol v1の `signal` と同じ形だが別schemaとして所有） |

- すべてclosed schema（`additionalProperties: false`）。未知fieldは `JOURNAL_CORRUPT`
- **同一object内でmember名の重複は `JOURNAL_CORRUPT`**（escape表記ではなくdecode後の名前で比較するprotocolと同じlexical rule。schemaでは表現できない）
- `signal` は `attemptId` とtyped `candidateDigest`を必須にする。external evidence digestとrepair causationは保存しない
- `signal` の条件規則（kindとroleの対応、`findingCount` / `artifactRef` / `shortErrorCode` の必須・禁止）は [`record.schema.json`](schemas/record.schema.json) がprotocol v1のrequest schemaと同じ形で持つ
- **schemaとruntime decoder（`aizign-store-jsonl`）の受理集合は同一**。`spec/conformance/{valid,invalid}/journal` の同じfixtureを、runtimeは `decode_record`（`crates/aizign-store-jsonl/tests/conformance.rs`）、schemaは [`spec/test/schema.test.mjs`](../../test/schema.test.mjs) が読み、`.expect.json` の `schema` 判定で両者を突き合わせる
- `seq` の範囲はschemaとruntimeで一致させる: `1..=10000`（`MAX_JOURNAL_ENTRIES`。cold readがこの件数でboundされるため、これを超えるseqを持つdurable fileは読めない）
- 整数の字句表現はprotocolと同じくcanonical token（`1.0` などは `JOURNAL_CORRUPT`）。schemaでは表現できないのでfixtureに `schema: true` と記録する
- optional fieldは省略する。`null` は `JOURNAL_CORRUPT`
- 本文、credential、harness ID（`prompt`、`output`、`reasoning`、`token`、`sessionId`、`threadId` など）にあたるfieldは存在しない。record schemaがclosedなので、そのようなfieldを持つrecordは読み込めない

## 読み取りの規則（bounded committed cold read）

- readerは既存のstate directory、lock、journal、commit metadataだけをread-onlyで開き、shared non-blocking lockを取得する。欠落はempty stateではなく `JOURNAL_UNAVAILABLE`
- commit metadataが示すbyte prefixだけがauthoritative。physical fileがprefixより長ければ、完全なrecordに見えても未公開tailなので `JOURNAL_OUTCOME_UNKNOWN`。readerはsync、promote、truncate、repairしない
- committed prefixは改行で終わる。最後のrecordが途中で切れていれば `JOURNAL_CORRUPT`（黙って捨てない）
- committed byte length、entry count、SHA-256 digestが実fileと一致しなければ `JOURNAL_CORRUPT`
- `schemaVersion` が違えば `JOURNAL_SCHEMA_UNSUPPORTED`
- record数が `10000` を超えれば `JOURNAL_BOUND_EXCEEDED`
- `signal` はcoreの検証（kind / role、`findingCount` などの制約）を通らなければ `JOURNAL_CORRUPT`
- replayは各accepted eventのattempt / candidate pairを復元する。同じrevision identifierを持つ別event間のdigestは比較しない
- Journal schema v1は未releaseのためADR-0012でin-place更新した。旧shapeは読み込まない

## 書き込みの規則

- `seq` は直前のrecord + 1。**10000件に達した後のappendは書き込まず `JOURNAL_BOUND_EXCEEDED`**。fileを変えず、acceptedにもしない（成功を返した直後に次回cold readが読めないjournalを作らないため）。encoder（`encode_record`）もrange外の `seq` を生成できない
- writerはexclusive non-blocking lockを取得し、既存のpublished prefixとphysical fileが完全一致する場合だけappendする。未公開tailを見つけたらappendもpromoteもせず `JOURNAL_OUTCOME_UNKNOWN`
- 1行を `write_all` し、journal fileの `sync_all` が成功した後にだけ、新しいcommit metadataをowner-only temporary file → `sync_all` → atomic replace → state directory barrierの順で公開する
- journal write開始後のfile barrier、metadata publish、directory barrierの失敗は `JOURNAL_OUTCOME_UNKNOWN`。再送しない。旧commit pointが残れば追加bytesはunpublished tailとして扱う
- fresh storeはstate directory、lock、journal、初期commit metadataと必要なdirectory entryをwriter側でdurableに初期化してからempty snapshotを公開する。readerは初期化を完了しない
- incompatible lockを取れなければ `JOURNAL_LOCKED`

## Files

- `schemas/record.schema.json` — JSON Schema draft 2020-12
- `examples/workflow.jsonl` — 3 recordの例
- `../../store/v2/` — current/target commit metadata、publication witness、store-layout version
- `../../store/v1/` — historical unsupported compatibility-rejection format
