# @aizu/adapter-dsh

The DSH harness adapter: a cordis plugin that registers one **scope-bound** `submit_workflow_signal` tool backed by the `aizu` binary over Protocol v1.

| | |
|---|---|
| **Responsibility** | DSH plugin entry（`name` / `inject` / `Config` / `apply`）、preflight（`aizu hello` → protocol version + capability）、`OneShotCoreClient`、agentの引数 → `workflow.signal.submit` payload のmapping、coreの結果 → tool result / `HarnessError`、durable evidence（`tool/result` の `meta` に digest を記録し、session logの cold read で照合） |
| **Non-responsibility** | 判断（core）、journal（coreのJSONL。DSH persistenceには書かない）、identityの決定（configで固定。agentは知らない）、live smokeの手順（operatorの `op/`） |
| **Inputs** | plugin config（binary、stateDir、timeoutMs、eventId + expected assignment）、agentのtool call `{ kind, findingCount?, artifactRef?, shortErrorCode? }` |
| **Outputs** | tool result `{ disposition: accepted \| duplicate, eventId }`、または `HarnessError`（protocol / workflow code、`AIZU_OUTCOME_UNKNOWN`、`AIZU_UNAVAILABLE`、`AIZU_INCOMPATIBLE`） |
| **Hard invariants** | identity（eventId、workflowId、assignmentId、role、artifactRevision）をtool schema・引数・promptに出さない（5、8）、DSHのcall id / session idをpayloadに入れない（8）、`unknown` は `AIZU_OUTCOME_UNKNOWN` として返し再送しない（3、4）、preflight失敗時はtoolを登録しない、環境変数を子processへ丸ごと渡さない（PATHのみ） |
| **Allowed dependencies** | `@aizu/protocol`。peer: `@deepseek-ai/cordis` 4.0.1、`dsh-llm` / `dsh-tools` 0.1.1-rc.2、`schemastery` 3.18.1（exact、ADR-0010）。dev: `@aizu/adapter-testkit` |
| **Test command** | `npm test -w @aizu/adapter-dsh`（`AIZU_BINARY` を与えると実binaryにも） |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0010](../../docs/adr/0010-harness-sdk-dependencies-and-node-policy.md) |

## Layout

```text
src/
├── index.ts                       plugin entry: name / inject / Config / apply、createClient
├── config.ts                      Config（schemastery）、validateConfig、SignalBinding、bindingPayload
├── core-client/one-shot-client.ts OneShotCoreClient（spawn → 1 frame → 1 frame、abort、unknownの分類）
├── mapping/tool.ts                createSubmitWorkflowSignalTool、decodeArgs、toPayload、toToolResult、presentationMetaFor、adapterCodes
├── lifecycle/preflight.ts         hello → checkCompatibility
└── evidence/
    ├── digest.ts                  canonicalJson、bindingDigest、payloadDigest（sha256）
    └── cold-read.ts               readSignalEvidence(source, sessionId, binding): session logの tool/call + tool/result 対からの evidence
test/
├── helpers/fake-dsh.ts            FakeDsh（tool registry + DSH風dispatch + in-memory session log）、fakeBinary
├── unit/                          config、tool mapping（identity非露出、metadata-only、unknown非再送）、evidence、plugin apply
└── conformance/
    ├── core-client.test.ts        runCoreClientConformance + 実binary
    └── round-trip.test.ts         fake DSH → plugin → fake core / 実binary → journal → cold read、crash時の unknown
cordis.patch.yml                   bundle時にdisabledで挿入。operatorのpatchが有効化する
```

## 設定

```yaml
# operator patch (op/ 側。repositoryには置かない)
- insert:
    - id: aizu-workflow-signal
      name: "@aizu/adapter-dsh"
      config:
        binary: /path/to/aizu
        stateDir: /path/to/runtime/aizu-state
        timeoutMs: 15000
        eventId: evt-0001
        workflowId: wf-example
        assignmentId: as-implementation
        role: implementation
        artifactRevision: rev-c0ffee
```

## Evidence

completionの正本はjournal（core側）です。adapterはそれに加えて、toolの `presentationMeta` で durable な `tool/result` event の `meta` に
`{ tool, eventId, disposition, bindingDigest, payloadDigest }` を書きます。`readSignalEvidence` はsession logを cold read し、
最後の `tool/call`（このtool）と対になる `tool/result` を探して、`eventId` と `bindingDigest` を plugin config から再計算した値と照合します。

| 結果 | 意味 |
|---|---|
| `accepted` / `duplicate` | 対が揃い、digestが一致 |
| `rejected { code }` | `tool/result` が error（`EVENT_CONFLICT`、`AIZU_OUTCOME_UNKNOWN` など） |
| `unknown no_result` | `tool/call` はあるが `tool/result` がない（crash等）。後続の発話からは推測しない |
| `unknown meta_mismatch` | 別のidentityの結果、または metadata がない |
| `absent` | このtoolの呼び出しがない |

`EvidenceSource` は構造的port（`readFrom(sessionId, fromSeq)`）で、DSHの `SessionPersistence` がそのまま満たします。session idはadapterの入力であり、coreへは渡りません。

## Harness-facing codes

| Code | 意味 |
|---|---|
| `AIZU_UNAVAILABLE` | preflightでbinaryに到達できない、または `hello` がerror |
| `AIZU_INCOMPATIBLE` | protocol versionが違う、またはcapabilityがない |
| `AIZU_OUTCOME_UNKNOWN` | 提出の結果が不明（無応答、garbage、timeout、abort、`JOURNAL_OUTCOME_UNKNOWN`）。再送しない |
| `INVALID_SIGNAL` ほか | protocol / workflow codeをそのまま転送 |
| `INVALID_EXPECTATION` | plugin configのidentityが不正 |
