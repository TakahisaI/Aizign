# Architecture overview

この文書は **現在のarchitecture** を記述します。決定の理由と経緯は [ADR](../adr/) にあります。

## 一文で

Aizuは、harness（LLM agentを動かす実行環境）から来る **structured signal** と、harnessへ送る **effect intent** を、
決定論的なcoreで判断し、その判断をmetadata-onlyなjournalへdurableに記録するorchestration coreです。

## 構造

```text
┌─────────────────────────────┐
│ Harness adapter             │  harness固有: session、tool、native event、persistence
│ (@aizu/adapter-dsh など)    │  adapterだけがharness SDKを知る
└──────────────┬──────────────┘
               │ Aizu Protocol v1 (NDJSON, one request / one response, one-shot subprocess)
┌──────────────▼──────────────┐
│ aizu (binary) = aizu-cli    │  composition root。process境界、引数、exit code
│  ├─ aizu-protocol           │  envelope、version、capability、DTO <-> domain変換
│  ├─ aizu-store-jsonl        │  append-only journal (engineのJournal portを実装)
│  └─ aizu-engine             │  use case: load -> decide -> append -> claim effect -> report
│       └─ aizu-core          │  純粋な判断。State + Command -> Decision
└─────────────────────────────┘
```

| Layer | 役割 | 禁止 |
|---|---|---|
| `aizu-core` | workflow state、identity、command validation、event application、duplicate / conflict、next action、effect intent、authorization state、recovery disposition | I/O、clock、async、SDK、serialization、harness固有名 |
| `aizu-engine` | journal load、command適用、event append、effect claim、effect resultの還元、timeoutとbounded operation、port定義 | harness固有型 |
| `aizu-protocol` | NDJSON envelope、protocol version、capability negotiation、stable error code、DTO <-> domain変換、input size制限 | domain型の直接serialize |
| `aizu-store-jsonl` | append-only、owner-only、bounded cold read、schema version、atomic append、lock | raw conversation data |
| `aizu-cli` | composition root。`aizu handle`、`aizu hello` | business logic |
| adapter | harness Context / Session / Tool / native event / persistence / lifecycle / harness固有error | core内部型の参照、harness IDのcore identity化 |

## 一つのrequestの流れ

1. adapterがharnessのnative event（例: tool call）を受け取り、structured evidenceへ変換する。
2. adapterが `aizu handle --state <dir>` を起動し、stdinへ一つのrequest envelopeを書く。
3. `aizu-protocol` がenvelopeをclosed schemaでdecodeし、domain commandへ変換する。
4. `aizu-engine` がjournalをbounded cold readし、`aizu-core` にstateとcommandを渡す。
5. `aizu-core` が `Decision` を返す。内容は domain event の追加、effect intent、またはrejection。
6. engineはeventをjournalへappendする。effect intentがあれば **effect前にclaimをappend** する。
7. `aizu-protocol` がresponse envelopeへ変換し、stdoutへ一行で書く。logはstderr。processは終了する。
8. adapterはresponseのdispositionに従って次の動作を行う。`unknown` を成功や失敗へ推測しない。

## Functional core / imperative shell

- core: 純粋関数。`State + Command -> Decision`、`State + Event -> State`
- shell: engine以降。I/O、時間、processはshellが所有し、coreには値として渡す
- Portは利用側（engine）が定義し、store / adapterが実装する

## いま存在するもの

| 場所 | 状態 |
|---|---|
| `crates/aizu-core` | `identity` と `workflow` context（signal、command、event、state、decision、error）。`execution` 以降は後続 |
| `crates/aizu-protocol`、`spec/protocol/v1/` | Protocol v1: envelope、`hello`、`workflow.signal.submit`、closed decoder、schemaとexample |
| `crates/aizu-engine` | `Journal` / `Clock` port、`handle_workflow_signal` use case |
| `crates/aizu-store-jsonl`、`spec/journal/v1/` | JSONL journal: owner-only、lock、bounded cold read、fsync append、closed record |
| `crates/aizu-testkit` | `MemoryJournal`（fault injection）、`FixedClock`、`TempDir`、journal contract、signal helper |
| `crates/aizu-cli` | `aizu hello`、`aizu handle --state <dir>`: one-shot process、watchdog、stderr log |
| `xtask` | `cargo xtask check / conformance / public-audit` |
| `docs/`、`.github/` | governance、ADR、architecture、CI |
| `packages/`、`adapters/`、`spec/conformance/` | 未作成。最初の実装とともに追加 |

## 関連

- [context-map.md](context-map.md) — bounded contextと配置
- [dependency-rules.md](dependency-rules.md) — 依存してよいもの
- [data-boundary.md](data-boundary.md) — core / journal / adapterの間を越えてよいデータ
- ADR-0002、0003、0004、0005
