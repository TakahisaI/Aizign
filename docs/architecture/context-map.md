# Context map

`aizign-core` と `aizign-engine` はbounded context単位でmoduleを置きます（[ADR-0005](../adr/0005-organize-the-core-by-bounded-context.md)）。
この表は **配置の正本** です。新しいcontextを足すときはこの表を更新し、既存contextの責務を広げないでください。

## Core contexts (`crates/aizign-core/src/`)

| Context | Module | 責務 | 非責務 | v0.1 |
|---|---|---|---|---|
| Identity | `identity` | workflow / assignment / attempt / candidate revision / event の stable ID、digest、bounded timestampの最小語彙 | harness ID、provider ID | ✔ |
| Workflow | `workflow/` | workflow signalのcommand、event、state、decision、duplicate / conflict、expected assignmentとのattempt / candidate pair照合 | candidate lifecycle registry、external evidence provenance、repair causation、実行、配送、integration | ✔ |
| Execution | `execution/` | session / attemptのstate、effect intent、claim状態、terminal disposition、`unknown` | harness session操作そのもの | later |
| Evidence | `evidence/` | structured evidenceのbinding検証、digest照合、evidence disposition | harness persistenceの読み取り | later |
| Workspace | `workspace/` | writer lease、candidate revision、check evidenceのbinding | Git command、filesystem | later |
| Authorization | `authorization/` | revision-bound human authorizationのstateとconsume | CLI、operator UI | later |
| Integration | `integration/` | integration planとmilestone、CAS前提条件 | ref更新そのもの | later |
| Recovery | `recovery/` | replay済みworkflow stateに対するfull signalのpureなaccepted / conflict / absent分類 | durability判断、journal I/O、process監視 | ✔ |
| Usage | `usage/` | usage observationの共通型 | 収集、集計CLI | later |

`later` のcontextは、最初のstructured workflow signalが縦に通った後、旧実装をcontext単位で再評価して追加します。
そのときもこの表に行を足してからcodeを書きます。

## Engine (`crates/aizign-engine/src/`)

engineはuse caseとportを持ちます。contextの切り方はcoreと揃えます。

| 要素 | 内容 | 状態 |
|---|---|---|
| Use case | `handle_workflow_signal`: journal load → replay → core → append → outcome | 実装済み |
| Use case | `reconcile_workflow_signal`: committed load → replay → exact signal classification。append / clock / effectなし | 実装済み |
| Port | `JournalReader`（committed load）、これを拡張する`Journal`（append）、`JournalEntry`、`JournalError`、`Clock`（bounded timestamp） | 実装済み |
| Port | `EffectSink`（effect intentの配送） | 後続 |
| 所有 | portはengineが定義。store、testkit、cliが実装 | — |

## Protocol (`crates/aizign-protocol`, `packages/protocol`)

| 要素 | 内容 |
|---|---|
| Envelope | `protocol`、`version`、`requestId`、`kind`、`payload` |
| Kind | `hello`、`workflow.signal.submit`、`workflow.signal.reconcile`、以後は新しいkindとして追加 |
| 正本 | `spec/protocol/v1/schemas/`、`spec/protocol/v1/examples/` |

## Journal (`crates/aizign-store-jsonl`)

| 要素 | 内容 |
|---|---|
| Record | schema version付きのclosed record。metadata-only。`workflow.signal.accepted` |
| Store | `JsonlJournal` writer（exclusive lock、durable append / commit publish）、`JsonlJournalReader`（shared lock、strictly read-only committed cold read）、`aizign-testkit::MemoryJournal` |
| Commit point | `workflow.commit.json` がcommitted byte length / entry count / SHA-256を公開。extra tailはunknownでpromoteしない |
| 正本 | recordは`spec/journal/v1/`、store metadataは`spec/store/v1/` |

## Adapter (`adapters/<harness>/`)

All adapters share a current behavioral minimum, not a uniform feature set.
Keep these capability layers separate:

| Layer | Owner | Current representation |
|---|---|---|
| Core protocol capability | `aizign-protocol` and the binary | Request kinds advertised by `hello.capabilities` |
| Harness adapter capability | Each adapter and its harness-native tests | Adapter documentation only; no universal manifest or Protocol v1 field |
| Workflow requirement | Future orchestration policy | No v0.1 consumer or runtime representation |

The current minimum is protocol health and compatibility checking, scope-bound
structured signal submission, trusted identity injection, full response
correlation, exact outcome propagation, non-collapse of `unknown`, metadata-only
data flow, and bounded request and response handling. Persisting an outcome,
reading harness-native evidence, and implementing lifecycle operations are not
minimum requirements.

`hello`, `workflow.signal.submit`, and `workflow.signal.reconcile` are the
implemented core protocol operations. Core reconciliation is a bounded
read-only lookup of the Aizign journal, not a harness evidence capability. The
DSH adapter separately demonstrates optional harness-persisted success metadata
integration, a caller-wait timeout plus post-read event-count guard, and
binding-digest verification plus payload-digest recording. These DSH
integrations do not by themselves establish a real-persistence durability or
retention contract, a source-side I/O or byte bound, or payload-digest
verification.

Interrupt, effect dispatch, resource release, session or agent ownership,
general lifecycle hooks, and remote reconnect are provisional. They have no
stable capability token until a dedicated contract defines their consumer and
absence semantics.

Adapter code placement follows ownership rather than a mandatory directory
template:

| Concern | Placement |
|---|---|
| Aizign process, protocol exchange, and `hello` | adapter-owned core-client boundary |
| Native input to protocol DTO | adapter-owned mapping boundary |
| Harness persistence and native evidence | optional adapter-owned evidence boundary |
| Approved harness lifecycle operations | optional adapter-owned lifecycle boundary |
| Verification | protocol scenarios plus harness-native fake tests |

See [Adding a harness adapter](../development/adding-adapter.md) for the current
minimum, optional capability rules, and TypeScript reference layout.
