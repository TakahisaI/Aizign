# aizign-cli

The `aizign` binary: composition root and canonical one-shot process-profile
child (ADR-0003, ADR-0022).

| | |
|---|---|
| **Responsibility** | 引数、stdin / stdout、system clock、state directoryの選択、submit用`JsonlJournal` / reconcile用`JsonlJournalReader` と `aizign-engine` の結線、engine/store観測のchild timing recordへの合成、処理時間のbound、stderrへの構造化log |
| **Non-responsibility** | business logic（`aizign-core`）、use caseとengine stage語彙（`aizign-engine`）、wire format（`aizign-protocol`）、journal formatとphysical stage語彙（`aizign-store-jsonl`） |
| **Inputs** | `aizign hello` / `aizign handle --state <dir>` + stdinの1 frame |
| **Outputs** | stdoutに1 frame。exit code |
| **Hard invariants** | `handle`は非空body `<=65536` + LF + immediate EOFだけをdispatchし、CRLF・LF-less・全post-LF byteをstate access前に拒否、stdoutにはbounded response body + LF以外を書かない、stderrに本文を出さない、submitの`accepted`はappend後だけ、reconciliationはread-only readerしか開かない、pre-dispatch timeoutはno-effect、post-dispatch timeoutはpossible-effect `unknown`で再送しない |
| **Allowed dependencies** | `aizign-core`、`aizign-engine`、`aizign-protocol`、`aizign-store-jsonl`。dev: `aizign-testkit` |
| **Test command** | `cargo test -p aizign-cli` |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0005](../../docs/adr/0005-organize-the-core-by-bounded-context.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md)、[0019](../../docs/adr/0019-separate-engine-and-store-observation-ownership.md)、[0022](../../docs/adr/0022-define-the-canonical-one-shot-process-profile.md) |

## Security boundary

The CLI trusts the operator-selected binary invocation and state directory. It
bounds framing and caller wait, but a timeout or killed worker cannot prove
that no append occurred and therefore remains `unknown`. Stderr carries bounded
operational metadata rather than content; log retention remains operator-owned.
See the [v0.1 threat model](../../docs/security/threat-model.md).

## 使い方

```sh
aizign hello                                  # handshake。stateに触らない
printf '%s\n' '<request body>' | aizign handle --state ./.aizign-state
```

| Exit code | 意味 |
|---|---|
| `0` | response frameを書いた（`ok: false` でも `0`） |
| `2` | 引数error。frameなし |
| `3` | stdinを読めない、またはstdoutに書けない。frameなし |

## 挙動

1. worker threadでstdinを読む: 非空bodyを `MAX_REQUEST_BYTES` までbufferし、LFとimmediate EOFを確認する。LF-less EOF、CRLF、65,537 byte目、LF後の全byteをProtocol decode・state access前に拒否する
2. 同じworker threadで `decode_request` → `hello` ならhello info、`workflow.signal.submit` ならexclusive writerの `JsonlJournal::open` → `handle_workflow_signal`、`workflow.signal.reconcile` ならshared read-onlyな `JsonlJournalReader::open` → `reconcile_workflow_signal`
3. 10秒で打ち切り（stdinのreadとrequired EOF待ちを含む）。dispatch前の `HANDLER_TIMEOUT` はstate effectなし、dispatch後は進行中のappend結果が不明として再送しない。boundはtest用に `AIZIGN_HANDLE_TIMEOUT_MS`（1..=600000）で上書きできる
4. stderrに `aizign: stage=... requestId=... kind=... outcome=...` を1行

## Opt-in timing

Setting `AIZIGN_TIMING_JSON=1` makes `handle` emit one additional
metadata-only JSON line on stderr, prefixed with `aizign_timing:`. This is an
internal, provisional child-runtime observation, not Protocol v1, package
compatibility, workflow authority, or a stable public schema. Its current
`schema_version: 1` is only an internal producer/consumer guard and provides no
external stability or migration promise.

The record includes only reached stages: request read, decode, journal open,
committed-prefix read, verification hash, decode, replay, decision, append and
`sync_all`, publish-prefix hash, response encode, response write, and handler
total. Values may include an allowlisted operation kind, the child runtime's
`outcome` observation, a stable error code, journal physical bytes, and
committed entries. Request IDs, state paths, content, and credentials are not
included.

The engine owns only aggregate load/replay/decide/append observations. The
JSONL store owns journal open, physical-byte, committed-prefix, and publication
hash observations. The CLI maps both owner-supplied vocabularies into this
unchanged flat record; it does not inspect the journal path or define physical
stage meaning.

The child `outcome` observation is source-qualified. It is not the returned
client outcome or a parent transport observation, and these sources must not
be treated as one universal semantic outcome. The
[classification corpus](../../spec/classification/README.md) is the sole row
authority. Exhaustive CLI tests apply all 78 rows to this child observation
projection; the CLI does not load the corpus as a runtime service.

Timing generation and output are best effort: failure does not change the
response or exit code. Without the environment variable, the normal path uses
the raw JSONL store and unobserved engine API; it does not construct either
observer, run stage clocks, or perform the additional physical-length stat.

See the [performance runner documentation](../../benchmarks/performance/README.md#measurement-intervals)
for field-level measurement intervals and the provisional lifecycle.

`hello` responseの `journalSchemaVersion` は `aizign-store-jsonl` の定数から、`package.version` はこのcrateのversionから取ります。検証済みの `x86_64-unknown-linux-gnu` buildだけがsubmitとreconcileをadvertiseします。x32を含む別ABIや別architecture / libcのLinux、macOS、BSD、Windowsなどの未検証storage targetでは両capabilityをadvertiseせず、直接送られたrequestはstateへ触れず `CAPABILITY_UNSUPPORTED` を返します。
