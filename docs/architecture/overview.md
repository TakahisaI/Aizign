# Architecture overview

This document describes the **current architecture**. ADRs record the reasons
and decision history. Future concepts are listed separately and have no current
Protocol v1, public API, durable-record, or runtime effect.

## In one sentence

Aizign's current runtime deterministically classifies structured workflow
signals, durably appends accepted signals to a metadata-only journal, and
performs bounded read-only reconciliation against the published committed
snapshot.

## 構造

```text
┌─────────────────────────────┐
│ Harness adapter             │  harness固有: session、tool、native event、persistence
│ (@aizign/adapter-dsh など)    │  adapterだけがharness SDKを知る
└──────────────┬──────────────┘
               │ Aizign Protocol v1 (NDJSON, one request / one response, one-shot subprocess)
┌──────────────▼──────────────┐
│ aizign (binary) = aizign-cli    │  composition root。process境界、引数、exit code
│  ├─ aizign-protocol           │  envelope、version、capability、DTO <-> domain変換
│  ├─ aizign-store-jsonl        │  append-only journal + store-owned publication authority (JournalReader / Journal)
│  └─ aizign-engine             │  submitとread-only reconciliationのuse case
│       └─ aizign-core          │  純粋な判断。State + Command -> Decision
└─────────────────────────────┘
```

| Layer | Current responsibility | Prohibited |
|---|---|---|
| `aizign-core` | Workflow state, identity/binding validation, event application, duplicate/conflict decisions, and pure reconciliation disposition | I/O, clock, async, SDKs, serialization, harness-specific names, external-effect execution |
| `aizign-engine` | Committed journal load, signal decision, accepted-event append, read-only reconciliation, bounded use-case stage observation, and journal/clock ports | Store-physical observation, harness-specific types, and external-effect dispatch/claim/result/reconciliation |
| `aizign-protocol` | NDJSON envelope、protocol version、capability negotiation、stable error code、DTO <-> domain変換、input size制限 | domain型の直接serialize |
| `aizign-store-jsonl` | append-only、owner-only、writer-published store authority、bounded read-only cold read、record / store metadata version、shared / exclusive lock、JSONL physical observation seam | raw conversation data、reader-side sync / repair / tail promotion |
| `aizign-cli` | composition root。`aizign handle`、`aizign hello` | business logic |
| adapter | harness Context / Session / Tool / native event / persistence / lifecycle / harness固有error | core内部型の参照、harness IDのcore identity化 |

adapterが満たす言語中立のbehavioral boundaryは
[`harness-adapter-contract.md`](harness-adapter-contract.md)が所有します。
Protocol v1のwire schemaは `spec/protocol/v1/` が所有し、TypeScript packageはその
reference / convenience layerです。

## Current signal-submission flow

1. adapterがharnessのnative input（例: tool call）を受け取り、closed workflow signalへ変換する。
2. adapterが `aizign handle --state <dir>` を起動し、stdinへ一つのrequest envelopeを書く。
3. `aizign-protocol` がenvelopeをclosed schemaでdecodeし、domain commandへ変換する。
4. `aizign-engine` がjournalをbounded cold readし、`aizign-core` にstateとcommandを渡す。
5. `aizign-core` returns a decision to accept, classify as a duplicate, or
   reject the signal.
6. For a new acceptance, the engine durably appends the accepted-signal event
   before the server returns the `accepted` disposition.
7. `aizign-protocol` がresponse envelopeへ変換し、stdoutへ一行で書く。logはstderr。processは終了する。
8. The adapter validates the response and correlation, then preserves the
   source-qualified client outcome. It never infers success or failure from
   `unknown`.

After restart, an adapter may query the same complete signal through
`workflow.signal.reconcile`. Under the accepted store v2 target, the reader
inspects only the exact prefix named by `workflow.commit.json` and released by
the matching CLEAN `workflow.publish.json`; the server reconciliation disposition is
`accepted`, `conflict`, or `absent`. Missing or inconsistent storage, an active
writer, corruption, an unpublished tail, and transport or correlation failure
cannot produce those dispositions and are preserved by the client as
`unknown`. Reconciliation creates, synchronizes, repairs, and appends nothing.
Production implements store v2 and qualifies the exact
`linux-x86_64-gnu-ext4-local-v1` profile before use. Path qualification failure
is `JOURNAL_UNAVAILABLE`; unsupported targets advertise no store capability.
Store v1 remains an unsupported historical format.

Cross-language classification ownership for current operation/code
combinations belongs to the
[classification contract](../../spec/classification/README.md). Its corpus is
now the sole row authority and its consumer projections are checked
exhaustively across Rust and TypeScript. Wire shapes and server codes remain
owned by the Protocol specification. Architecture
documents do not create a universal outcome service or a second semantic
table.

## Future/provisional inventory

The following inventory preserves durable design principles without claiming
that an effect runtime exists.

| Provisional concept | Current status | Promotion trigger |
|---|---|---|
| External-effect intent, durable claim, dispatch, result recording, and effect reconciliation | No consumer, owner, Protocol kind/capability, public API, durable record, state machine, or runtime operation exists. | A dedicated accepted Issue and any required ADR must name the consumer and owner; define the Protocol kind/capability; define the durable record, authority, and state shape; define failure, unknown, retry, and reconciliation semantics; and identify executable tests. Only then may current architecture and compatibility claims include the operation. |

This trigger does not decide the diagnostics work in #83, capability work in
#78, store design in #81, provenance work in #72, or executor work in #87.

## Functional core / imperative shell

- core: 純粋関数。`State + Command -> Decision`、`State + Event -> State`
- shell: engine以降。I/O、時間、processはshellが所有し、coreには値として渡す
- Workflow-use-case ports are defined by their consumer (`aizign-engine`) and
  implemented by the store or shell. JSONL physical observation is defined by
  its implementation owner (`aizign-store-jsonl`) and consumed by the CLI.

## いま存在するもの

| 場所 | 状態 |
|---|---|
| `crates/aizign-core` | `identity`, `workflow`, and pure `recovery` (classification of a complete signal as accepted/conflict/absent). Candidate lifecycle, provenance, repair causation, execution, and effects are not current. |
| `crates/aizign-protocol`、`spec/protocol/v1/` | Protocol v1: envelope、`hello`、signal submit / reconcile、closed decoder、schemaとexample |
| `crates/aizign-engine` | `JournalReader` / `Journal` / `Clock` / best-effort use-case stage observation port、submit / reconcile use case |
| `crates/aizign-store-jsonl`、`spec/journal/v1/`、`spec/store/v2/` | Current JSONL authority and implementation: owner-only journal, v2 commit generation plus PREPARED/CLEAN witness, bounded read-only cold read, exact ext4 profile, and store-owned physical observation. `spec/store/v1/` is retained only for rejection evidence. |
| `crates/aizign-testkit` | `MemoryJournal`（fault injection）、`FixedClock`、`TempDir`、journal contract、signal helper |
| `crates/aizign-cli` | `aizign hello`、`aizign handle --state <dir>`: one-shot process、watchdog、stderr log |
| `xtask` | `cargo xtask check / conformance / public-audit / performance-baseline` |
| `docs/`、`.github/` | governance、ADR、architecture、CI |
| `spec/conformance/` | language-neutral fixture（件数はtreeが正。`cargo xtask conformance` が構造を検証し、Rust / TS testが全fixtureをdecoderへ通す） |
| `packages/protocol` | `@aizign/protocol`: Node-free TypeScript codec（同じfixtureを通す）、bounded framing、`checkCompatibility`、correlation、submit / reconcileを含むabstract `CoreClient` contract |
| `packages/adapter-testkit` | `@aizign/adapter-testkit`: TypeScript向けfake core、scripted fault support、supplied production clientへ適用するsubmit / reconcile runner。production transportを持たない |
| `experiments/dsh-live-smoke` | opt-in live smokeのpatch生成とjournal要約（手順はoperator側） |
| `adapters/dsh` | `@aizign/adapter-dsh`: DSH pluginと唯一のproduction TypeScript one-shot transport（preflight、scope-bound `submit_workflow_signal`、control-plane reconciliation client）。stable rootはplugin entryのみ。fake DSH runtime + fake core / 実binaryの往復で検証し、harness persistenceやsession cold readには依存しない |

## 関連

- [context-map.md](context-map.md) — bounded contextと配置
- [dependency-rules.md](dependency-rules.md) — 依存してよいもの
- [data-boundary.md](data-boundary.md) — core / journal / adapterの間を越えてよいデータ
- [harness-adapter-contract.md](harness-adapter-contract.md) — adapterが満たす言語中立のbehavioral contract
- [threat-model.md](../security/threat-model.md) — v0.1のtrust domain、guarantee level、known limitation
- ADR-0002、0003、0004、0005
