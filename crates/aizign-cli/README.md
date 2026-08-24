# aizign-cli

The `aizign` binary: composition root, and the one-shot NDJSON process boundary (ADR-0003).

| | |
|---|---|
| **Responsibility** | 引数、stdin / stdout、system clock、state directoryの選択、submit用`JsonlJournal` / reconcile用`JsonlJournalReader` と `aizign-engine` の結線、処理時間のbound、stderrへの構造化log |
| **Non-responsibility** | business logic（`aizign-core`）、use case（`aizign-engine`）、wire format（`aizign-protocol`）、journal format（`aizign-store-jsonl`） |
| **Inputs** | `aizign hello` / `aizign handle --state <dir>` + stdinの1 frame |
| **Outputs** | stdoutに1 frame。exit code |
| **Hard invariants** | stdoutにはresponse frame以外を書かない、stderrに本文を出さない（identity、kind、codeのみ）、submitの`accepted`はappend後だけ、reconciliationはread-only readerしか開かない、timeout時は `HANDLER_TIMEOUT`（outcome unknown）で再送しない |
| **Allowed dependencies** | `aizign-core`、`aizign-engine`、`aizign-protocol`、`aizign-store-jsonl`。dev: `aizign-testkit` |
| **Test command** | `cargo test -p aizign-cli` |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0005](../../docs/adr/0005-organize-the-core-by-bounded-context.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md) |

## 使い方

```sh
aizign hello                                  # handshake。stateに触らない
echo '<request frame>' | aizign handle --state ./.aizign-state
```

| Exit code | 意味 |
|---|---|
| `0` | response frameを書いた（`ok: false` でも `0`） |
| `2` | 引数error。frameなし |
| `3` | stdinを読めない、またはstdoutに書けない。frameなし |

## 挙動

1. worker threadでstdinを読む: 1行目は `MAX_REQUEST_BYTES` + 1 までしかbufferせず、改行後はEOFまで走査して「frame 1つ + 末尾whitespace」以外を拒否する
2. 同じworker threadで `decode_request` → `hello` ならhello info、`workflow.signal.submit` ならexclusive writerの `JsonlJournal::open` → `handle_workflow_signal`、`workflow.signal.reconcile` ならshared read-onlyな `JsonlJournalReader::open` → `reconcile_workflow_signal`
3. 10秒で打ち切り（**stdinのread込み**。one-frame検査はEOFまで走査するので、stdinを閉じないcallerもこのboundで終わる）。打ち切り時は `HANDLER_TIMEOUT` を返す。進行中のappendの結果は不明として扱い、再送しない。boundはtest用に `AIZIGN_HANDLE_TIMEOUT_MS`（1..=600000）で上書きできる（adapterは子processへ `PATH` しか渡さないので、harness側からは届かない）
4. stderrに `aizign: stage=... requestId=... kind=... outcome=...` を1行

`hello` responseの `journalSchemaVersion` は `aizign-store-jsonl` の定数から、`package.version` はこのcrateのversionから取ります。Linux buildだけがsubmitとreconcileをadvertiseします。macOS・BSD・Windowsを含む未検証storage platformでは両capabilityをadvertiseせず、直接送られたrequestはstateへ触れず `CAPABILITY_UNSUPPORTED` を返します。
