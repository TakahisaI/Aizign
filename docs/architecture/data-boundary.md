# Data boundary

core、journal、adapter、logの間を **越えてよいデータ** と **越えてはならないデータ** の正本です。
[ADR-0004](../adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md)、
[ADR-0007](../adr/0007-use-metadata-only-control-journals.md)、[SECURITY.md](../../SECURITY.md) と整合します。

## 原則

- coreへ渡すのは **判断に必要な構造化された値だけ**。本文、画面、自然言語は渡さない
- journalは **metadata-only**。本文はjournalの外（harness persistence、workspace artifact）に置き、journalにはdigestと参照だけを書く
- harness / provider固有のidentityはadapterの外に出さない
- stdoutはprotocol response専用。logはstderr。logにも本文を出さない

## Adapterだけが保持してよいもの

| データ | 理由 |
|---|---|
| harness session ID | harness差し替えでidentityが変わるため、core identityにしない |
| provider thread / turn ID | 同上 |
| native event（tool call / result、session event） | adapterがstructured evidenceへ変換する |
| raw delivery receipt | adapterがdispositionへ変換する |
| harness persistence record | evidenceのcold read元。正本はjournal |
| credential location、browser profile | coreとjournalは一切知らない |

## Coreへ渡してよいもの

| データ | 形 |
|---|---|
| stable workflow identity | `workflowId`、`assignmentId`、`attemptId`、`artifactRevision`、`eventId`、repairの`sourceEventId` |
| bounded opaque handle | adapterが発行する長さ制限付きの不透明文字列。coreは比較と保存以外に使わない |
| digest | `candidateDigest`、external artifactの`evidenceDigest`、adapterのbinding / payload digest。algorithmを明示 |
| structured evidence | closed schemaのsignal（kind、findingCount、artifactRef / evidenceDigest、sourceEventId、shortErrorCode など） |
| disposition | `accepted`、`duplicate`、`conflict`、`unknown`、terminal状態 |
| stable short error code | `^[A-Z][A-Z0-9_]{0,63}$` |
| capability information | adapterの能力宣言 |
| bounded timestamp | shellが与える値。coreは現在時刻を取得しない |

## Journalに保存してよいもの / 禁止するもの

| 保存してよい | 禁止 |
|---|---|
| schema version、record kind | raw prompt |
| stable identity一式 | model output、reasoning |
| kind、disposition、short error code | stdout / stderr本文 |
| digest、bounded opaque handle | environment、credential、token |
| bounded timestamp、append sequence | browser profile、credential location |
| effect intentのclaim（intent ID、kind、対象identity） | harness session ID、provider thread ID |

journal recordはclosed schemaで、禁止項目にあたるfield名を持つrecordを拒否します。

## Log

| 出力先 | 内容 |
|---|---|
| stdout（`aizign` binary） | protocol responseの一行だけ |
| stderr | 構造化された診断。identity、kind、disposition、error code。本文なし |
| adapter log | 同上。harness IDはadapter内のlogに限り出してよいが、coreへは渡さない |

## Hard invariantsとの対応

| Invariant | この文書での境界 |
|---|---|
| 1. 自然言語、idle、画面表示を完了の正本にしない | coreへ渡すのはstructured evidenceだけ |
| 2. effect前にdurable claim | claimはjournal record |
| 3 / 4. `unknown` を推測しない | dispositionに `unknown` を持ち、adapterもcoreも縮約しない |
| 5. evidenceのbinding | identity一式、candidate content、external evidence content、repair causationを必須にする |
| 8. provider固有identityをcore identityにしない | adapterだけが保持 |
| 10. journalへ本文やcredentialを保存しない | 禁止列 |
| 12. duplicate / conflict | 同一identity・同一digestはduplicate、異digestはconflict |

## 検査

- `cargo xtask public-audit` — tracked treeのsecret、private path、旧repository名、依存境界
- journal / protocolのclosed schema test — 禁止fieldを持つrecordの拒否（各crate / packageのtest）
- adapter conformance — fake harnessで、harness ID（session id、call id）がprotocol requestの **envelope全体**（`requestId` を含む）へ漏れないことを検査。`requestId` はadapter所有のnonce
