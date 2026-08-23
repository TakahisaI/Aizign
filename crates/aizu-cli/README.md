# aizu-cli

The `aizu` binary: composition root, and the one-shot NDJSON process boundary (ADR-0003).

| | |
|---|---|
| **Responsibility** | 引数、stdin / stdout、system clock、state directoryの選択、`JsonlJournal` と `aizu-engine` の結線、処理時間のbound、stderrへの構造化log |
| **Non-responsibility** | business logic（`aizu-core`）、use case（`aizu-engine`）、wire format（`aizu-protocol`）、journal format（`aizu-store-jsonl`） |
| **Inputs** | `aizu hello` / `aizu handle --state <dir>` + stdinの1 frame |
| **Outputs** | stdoutに1 frame。exit code |
| **Hard invariants** | stdoutにはresponse frame以外を書かない、stderrに本文を出さない（identity、kind、codeのみ）、`accepted` はappend後だけ、timeout時は `HANDLER_TIMEOUT`（outcome unknown）で再送しない |
| **Allowed dependencies** | `aizu-core`、`aizu-engine`、`aizu-protocol`、`aizu-store-jsonl`。dev: `aizu-testkit` |
| **Test command** | `cargo test -p aizu-cli` |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0005](../../docs/adr/0005-organize-the-core-by-bounded-context.md) |

## 使い方

```sh
aizu hello                                  # handshake。stateに触らない
echo '<request frame>' | aizu handle --state ./.aizu-state
```

| Exit code | 意味 |
|---|---|
| `0` | response frameを書いた（`ok: false` でも `0`） |
| `2` | 引数error。frameなし |
| `3` | stdinを読めない、またはstdoutに書けない。frameなし |

## 挙動

1. worker threadでstdinを読む: 1行目は `MAX_REQUEST_BYTES` + 1 までしかbufferせず、改行後はEOFまで走査して「frame 1つ + 末尾whitespace」以外を拒否する
2. 同じworker threadで `decode_request` → `hello` ならhello info、`workflow.signal.submit` なら `JsonlJournal::open` → `handle_workflow_signal`
3. 10秒で打ち切り（**stdinのread込み**。one-frame検査はEOFまで走査するので、stdinを閉じないcallerもこのboundで終わる）。打ち切り時は `HANDLER_TIMEOUT` を返す。進行中のappendの結果は不明として扱い、再送しない。boundはtest用に `AIZU_HANDLE_TIMEOUT_MS`（1..=600000）で上書きできる（adapterは子processへ `PATH` しか渡さないので、harness側からは届かない）
4. stderrに `aizu: stage=... requestId=... kind=... outcome=...` を1行

`hello` responseの `journalSchemaVersion` は `aizu-store-jsonl` の定数から、`package.version` はこのcrateのversionから取ります。
