# Context map

`aizign-core` と `aizign-engine` はbounded context単位でmoduleを置きます（[ADR-0005](../adr/0005-organize-the-core-by-bounded-context.md)）。
この表は **配置の正本** です。新しいcontextを足すときはこの表を更新し、既存contextの責務を広げないでください。

## Core contexts (`crates/aizign-core/src/`)

| Context | Module | 責務 | 非責務 | v0.1 |
|---|---|---|---|---|
| Identity | `identity` | workflow / assignment / attempt / candidate revision / event の stable ID、digest、bounded timestampの最小語彙 | harness ID、provider ID | ✔ |
| Workflow | `workflow/` | Workflow-signal command, accepted event, state, decision, duplicate/conflict, and expected-assignment/candidate-pair checks | Candidate lifecycle registry, provenance, repair causation, execution, delivery, integration, effects | ✔ |
| Evidence | `evidence/` | structured evidenceのbinding検証、digest照合、evidence disposition | harness persistenceの読み取り | later |
| Workspace | `workspace/` | writer lease、candidate revision、check evidenceのbinding | Git command、filesystem | later |
| Authorization | `authorization/` | revision-bound human authorizationのstateとconsume | CLI、operator UI | later |
| Integration | `integration/` | integration planとmilestone、CAS前提条件 | ref更新そのもの | later |
| Recovery | `recovery/` | replay済みworkflow stateに対するfull signalのpureなaccepted / conflict / absent分類 | durability判断、journal I/O、process監視 | ✔ |
| Usage | `usage/` | usage observationの共通型 | 収集、集計CLI | later |

`later` means that a context is not part of the current runtime or public
contract. It requires its own accepted contract before code placement becomes
current.

### Future/provisional effect placement

`execution/`, an effect port, or another executor boundary is not reserved by
this document. Before any external-effect context or port is added, a dedicated
accepted Issue and any required ADR must name its consumer and owner; define
its Protocol kind/capability; define its durable record, authority, and state
shape; define failure, unknown, retry, and reconciliation semantics; and name
its tests. This is an inventory trigger, not a decision for #87.

## Engine (`crates/aizign-engine/src/`)

engineはuse caseとportを持ちます。contextの切り方はcoreと揃えます。

| 要素 | 内容 | 状態 |
|---|---|---|
| Use case | `handle_workflow_signal`: journal load → replay → core → append → engine result | 実装済み |
| Use case | `reconcile_workflow_signal`: committed load → replay → exact signal classification。append / clock / effectなし | 実装済み |
| Port | `JournalReader`（committed load）、これを拡張する`Journal`（append）、`JournalEntry`、`JournalError`、`Clock`（bounded timestamp） | 実装済み |
| Observation | `EngineObserver` owns only aggregate load / replay / decide / append use-case stages. Store-physical stages are not engine vocabulary. | 実装済み |
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
| Observation | `StoreObserver` and observed JSONL wrappers own open, physical-byte, committed-prefix read/hash/decode, and publication-hash observation. Pathless engine journals do not implement this seam. |
| 正本 | recordは`spec/journal/v1/`、store metadataは`spec/store/v1/` |

## Adapter (`adapters/<harness>/`)

The normative language-neutral behavior, capability layers, outcomes, evidence
rules, and conformance ownership are defined in
[Harness adapter contract](harness-adapter-contract.md). This context map owns
code placement only; it does not require one language or a uniform feature set.

Adapter code placement follows ownership rather than a mandatory directory
template:

| Concern | Placement |
|---|---|
| Aizign process, protocol exchange, and `hello` | adapter-owned core-client boundary |
| Native input to protocol DTO | adapter-owned mapping boundary |
| Harness persistence and native evidence | optional adapter-owned evidence boundary |
| Approved harness lifecycle operations | optional adapter-owned lifecycle boundary |
| Verification | language-neutral wire/core-client scenarios plus harness-native fake tests |

See [Adding a harness adapter](../development/adding-adapter.md) for the
implementation steps and TypeScript reference layout.
