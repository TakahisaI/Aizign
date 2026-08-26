# Glossary

Code identifiers are fixed in English. Classification words are always
source-qualified; the same spelling does not imply the same authority.

| Term | 意味 |
|---|---|
| **Harness** | LLM agentを動かす実行環境。session、tool、persistenceを持つ。例: DSH |
| **Adapter** | 特定のharnessとAizign protocolを接続するpackage。harness固有の型とIDはここに閉じる |
| **Core** | `aizign-core`。純粋な判断だけを持つRust crate |
| **Engine** | `aizign-engine`: current workflow-signal submit/reconciliation use cases and the ports those use cases require |
| **Workflow** | 一つのsoftware change全体の単位。`workflowId` で識別 |
| **Assignment** | workflow内でroleに割り当てた作業単位。`assignmentId` で識別 |
| **Role** | assignmentの種類。`implementation`、`review` |
| **Attempt** | assignmentをharness上で実行した一回。`attemptId` で識別。失敗や中断のあと別attemptを作る |
| **Candidate revision** | implementationが提出した変更の固定identity。人間／provider向けの`artifactRevision`と内容同一性を示す`candidateDigest`の組で、review、check、authorizationはこれにbindingする |
| **Event** | journalへappendされるdomain event。`eventId` で識別。`State + Event -> State` |
| **Command** | coreへの入力。`State + Command -> Decision` |
| **Decision** | Current core result for a workflow signal: accept with an event, duplicate, or explainable rejection |
| **Workflow signal** | agentが提出するstructured evidence。kind: `implementation_ready`、`review_findings`、`review_passed`、`repair_submitted`、`blocked` |
| **Expected assignment** | coreがsignalを照合する相手。workflow、assignment、attempt、role、candidate pairの組 |
| **Structured evidence** | closed schemaで表現された事実。自然言語ではない |
| **Binding** | evidenceをworkflow、assignment、attempt、candidate revision + content digestのpairへ結び付けること |
| **Digest** | 内容の固定長hash。candidate digestはcontrol planeが計算し、coreはcarry / compareする。DSHの`bindingDigest` / `payloadDigest`はadapter-localで別authority |
| **Effect intent (future/provisional)** | A possible future request for an external effect. No current consumer, owner, Protocol kind/capability, public API, or record exists. |
| **Effect claim (future/provisional)** | The durable pre-effect principle in invariant 2. No current claim record or effect operation exists. Promotion requires the trigger in the architecture overview. |
| **Submit server disposition** | `accepted` or `duplicate` in a successful `workflow.signal.submit` response. A Protocol error is not a disposition. |
| **Submit client outcome** | `accepted`, `duplicate`, `rejected`, or `unknown` after operation-specific response, code, correlation, and transport classification. |
| **Reconciliation disposition** | `accepted`, `conflict`, or `absent` for the exact full signal against a decoded committed snapshot. A client may instead be unable to establish a disposition and report `unknown`. |
| **Child runtime observation** | Provisional metadata-only operational evidence emitted by the `aizign` child about its handler path. |
| **Parent transport observation** | Provisional metadata-only operational evidence emitted by the caller about spawn, response, correlation, and the client result. |
| **Harness-native observation** | Adapter-specific evidence classified under that adapter's documented attribution, durability, retention, and failure contract. |
| **Duplicate** | 同一identity・同一内容の再提出。受理済みとして扱い、再記録しない |
| **Conflict** | 同一identity・異内容の提出。拒否し、error codeで説明する |
| **Unknown** | A source-qualified client/observation result stating that the relevant fact could not be established. For current signal submission, an unknown append or acknowledgement is neither success nor failure and never authorizes blind retry. |
| **Reconcile** | A bounded read-only comparison of a complete signal against a writer-published committed journal snapshot. The server disposition is `accepted`, `conflict`, or `absent`; a client that cannot establish one reports `unknown`. |
| **Opaque handle** | adapterが発行し、coreは比較と保存にだけ使う不透明な文字列 |
| **Capability** | adapterが提供できる操作の宣言。`hello` で交換する |
| **Protocol version** | wire contractの整数version。package versionと独立 |
| **Journal schema version** | journal recordの整数version。package versionと独立 |
| **Store metadata version** | committed-prefix documentの整数version。protocol versionとjournal record schema versionの双方から独立 |
| **Control journal** | workflowの正本となるmetadata-onlyのappend-only journal |
| **Committed prefix** | writerがfile / metadata / directory barrier後に`workflow.commit.json`で公開したJSONL byte prefix。readerはこれを越えるtailを受理根拠にしない |
| **Bounded** | 上限のあること。request size、record数、処理時間、cold read範囲に上限を置く |
| **Short error code** | `^[A-Z][A-Z0-9_]{0,63}$` の安定した識別子。[error-codes.md](error-codes.md) |
| **Live smoke** | 実harness、browser、providerを使うopt-in検査。通常CIでは起動しない |
| **Composition root** | 依存を束ねる唯一の場所。`aizign-cli` |

Cross-language classification ownership and the planned corpus are defined by
[`spec/classification/`](../../spec/classification/README.md). The glossary does
not define a universal outcome service. Future-effect terms become current
only after an accepted contract names the consumer and owner, Protocol
kind/capability, durable record/authority/state shape, failure/reconciliation
semantics, and tests.
