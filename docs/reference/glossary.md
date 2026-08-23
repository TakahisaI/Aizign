# Glossary

code identifierは英語で固定します。日本語訳は説明用で、識別子には使いません。

| Term | 意味 |
|---|---|
| **Harness** | LLM agentを動かす実行環境。session、tool、persistenceを持つ。例: DSH |
| **Adapter** | 特定のharnessとAizu protocolを接続するpackage。harness固有の型とIDはここに閉じる |
| **Core** | `aizu-core`。純粋な判断だけを持つRust crate |
| **Engine** | `aizu-engine`。use case、port、effect claimを持つ |
| **Workflow** | 一つのsoftware change全体の単位。`workflowId` で識別 |
| **Assignment** | workflow内でroleに割り当てた作業単位。`assignmentId` で識別 |
| **Role** | assignmentの種類。`implementation`、`review` |
| **Attempt** | assignmentをharness上で実行した一回。`attemptId` で識別。失敗や中断のあと別attemptを作る |
| **Candidate revision** | implementationが提出した変更の固定identity（`artifactRevision`）。review、check、authorizationはこれにbindingする |
| **Event** | journalへappendされるdomain event。`eventId` で識別。`State + Event -> State` |
| **Command** | coreへの入力。`State + Command -> Decision` |
| **Decision** | coreの出力。追加するevent、effect intent、またはrejectionを含む |
| **Workflow signal** | agentが提出するstructured evidence。kind: `implementation_ready`、`review_findings`、`review_passed`、`repair_submitted`、`blocked` |
| **Expected assignment** | coreがsignalを照合する相手。workflow、assignment、role、revisionの組 |
| **Structured evidence** | closed schemaで表現された事実。自然言語ではない |
| **Binding** | evidenceをworkflow、assignment、attempt、candidate revisionへ結び付けること。binding digestで照合する |
| **Digest** | 内容の固定長hash。journalには本文ではなくdigestを置く |
| **Effect intent** | coreが外部作用を要求する意図。adapterがharness操作へ変換する |
| **Claim** | effect intentを実行する前にjournalへdurableに記録すること |
| **Disposition** | 操作やevidenceの結果分類。`accepted`、`duplicate`、`conflict`、`unknown`、terminal |
| **Duplicate** | 同一identity・同一内容の再提出。受理済みとして扱い、再記録しない |
| **Conflict** | 同一identity・異内容の提出。拒否し、error codeで説明する |
| **Unknown** | effectやappendの結果が確定できない状態。成功にも失敗にも縮約せず、blind retryしない |
| **Reconcile** | restart後に、journalとharness persistenceをbounded read-onlyで照合すること |
| **Opaque handle** | adapterが発行し、coreは比較と保存にだけ使う不透明な文字列 |
| **Capability** | adapterが提供できる操作の宣言。`hello` で交換する |
| **Protocol version** | wire contractの整数version。package versionと独立 |
| **Journal schema version** | journal recordの整数version。package versionと独立 |
| **Control journal** | workflowの正本となるmetadata-onlyのappend-only journal |
| **Bounded** | 上限のあること。request size、record数、処理時間、cold read範囲に上限を置く |
| **Short error code** | `^[A-Z][A-Z0-9_]{0,63}$` の安定した識別子。[error-codes.md](error-codes.md) |
| **Live smoke** | 実harness、browser、providerを使うopt-in検査。通常CIでは起動しない |
| **Composition root** | 依存を束ねる唯一の場所。`aizu-cli` |
