# @aizign/adapter-dsh

The DSH harness adapter: a cordis plugin that registers one **scope-bound** `submit_workflow_signal` tool backed by the `aizign` binary over Protocol v1.

| | |
|---|---|
| **Responsibility** | DSH plugin entry（`name` / `inject` / `Config` / `apply`）、preflight（`aizign hello` → protocol version + capability）、`OneShotCoreClient`、agentの引数 → `workflow.signal.submit` payload のmapping、coreの結果 → tool result / `HarnessError`、durable evidence（`tool/result` の `meta` に digest を記録し、session logの cold read で照合） |
| **Non-responsibility** | 判断（core）、journal（coreのJSONL。DSH persistenceには書かない）、identityの決定（configで固定。agentは知らない）、live smokeの手順（operatorの `op/`） |
| **Inputs** | plugin config（binary、stateDir、timeoutMs、eventId + workflow / assignment / attempt / candidate digest）、agentのtool call `{ kind, findingCount?, artifactRef?, shortErrorCode? }` |
| **Outputs** | tool result `{ disposition: accepted \| duplicate, eventId }`、または `HarnessError`（protocol / workflow code、`AIZIGN_OUTCOME_UNKNOWN`、`AIZIGN_UNAVAILABLE`、`AIZIGN_INCOMPATIBLE`） |
| **Hard invariants** | control-plane identity（eventId、workflowId、assignmentId、attemptId、role、artifactRevision、candidateDigest）をtool schema・引数・promptに出さない（5、8）、DSHのcall id / session idを **envelope全体**（`requestId` 含む）に入れない（8。`requestId` はadapter所有のnonce）、responseは `requestId` / `kind` / `eventId` を送信と照合し不一致は `unknown`、stdoutは `MAX_FRAME_BYTES` と「frame 1つ」でbound、`unknown` は `AIZIGN_OUTCOME_UNKNOWN` として返し再送しない（3、4）、cold readは `maxEvents` / timeout でbound（9）、preflight失敗時はtoolを登録しない、環境変数を子processへ丸ごと渡さない（PATHのみ） |
| **Allowed dependencies** | `@aizign/protocol`。peer: `@deepseek-ai/cordis` 4.0.1、`dsh-llm` / `dsh-tools` 0.1.1-rc.2、`schemastery` 3.18.1（exact、ADR-0010）。dev: `@aizign/adapter-testkit` |
| **Test command** | `npm test -w @aizign/adapter-dsh`（`AIZIGN_BINARY` を与えると実binaryにも） |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0010](../../docs/adr/0010-harness-sdk-dependencies-and-node-policy.md) |

## Layout

```text
src/
├── index.ts                       plugin entry: name / inject / Config / apply、createClient
├── config.ts                      Config（schemastery）、validateConfig、SignalBinding、bindingPayload
├── core-client/one-shot-client.ts OneShotCoreClient（spawn → 1 frame → 1 frame、相関照合、frame bound、abort、unknownの分類）
├── mapping/tool.ts                createSubmitWorkflowSignalTool、decodeArgs、toPayload、toToolResult、presentationMetaFor、adapterCodes
├── lifecycle/preflight.ts         hello → checkCompatibility
└── evidence/
    ├── digest.ts                  canonicalJson、bindingDigest、payloadDigest（sha256）
    └── cold-read.ts               readSignalEvidence(source, sessionId, binding, { fromSeq, maxEvents, timeoutMs, signal }): bounded cold read
test/
├── helpers/fake-dsh.ts            FakeDsh（tool registry + DSH風dispatch + in-memory session log）、fakeBinary
├── unit/                          config、tool mapping（identity非露出、metadata-only、unknown非再送）、evidence、plugin apply
└── conformance/
    ├── core-client.test.ts        runCoreClientConformance + 実binary
    └── round-trip.test.ts         fake DSH → plugin → fake core / 実binary → journal → cold read、crash時の unknown
cordis.patch.yml                   bundle時にdisabledで挿入。operatorのpatchが有効化する
```

## 設定

このpackageは `dsh.bundle.patch` を宣言しているので、`dsh plugin --profile <name> add …` で入れるとDSHのbundle層に加わり、
[`cordis.patch.yml`](cordis.patch.yml) が entry `aizign-workflow-signal` を **`disabled: true` で挿入**します。
operatorのpatchはその entry を **id で上書き**して有効化します（同じidを `insert` で再挿入すると loader が `duplicate loader entry id` で起動しません）。

```yaml
# operator patch (op/ 側。repositoryには置かない)。--patch で渡すか、profileの cordis.patch.yml に置く
- id: aizign-workflow-signal
  name: "@aizign/adapter-dsh"   # bundle層の entry と一致しないと patch は skip される
  disabled: false
  config:
    binary: /path/to/aizign
    stateDir: /path/to/runtime/aizign-state   # 無ければ aizign が 0700 で作る。既存なら 0700 であること
    timeoutMs: 15000
    eventId: evt-0001
    workflowId: wf-example
    assignmentId: as-implementation
    attemptId: attempt-implementation-01
    role: implementation
    artifactRevision: rev-c0ffee
    candidateDigest:
      algorithm: sha256
      hex: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

`dsh --profile <name> --patch <file> --dump-config` で、合成後の tree に `aizign-workflow-signal` が `disabled: false` と上記 `config` で現れることを確認できます。
[`experiments/dsh-live-smoke/make-patch.mjs`](../../experiments/dsh-live-smoke/make-patch.mjs) はこの形を生成します。

## Evidence

completionの正本はjournal（core側）です。adapterはそれに加えて、toolの `presentationMeta` で durable な `tool/result` event の `meta` に
`{ tool, eventId, disposition, bindingDigest, payloadDigest }` を書きます。`readSignalEvidence` はsession logを cold read し、
最後の `tool/call`（このtool）と対になる `tool/result` を探して、`eventId` と `bindingDigest` を plugin config から再計算した値と照合します。adapter-localなbinding digestにはattemptとcandidate digestも含まれますが、Protocol v1の`candidateDigest`やcandidate bytesのauthorityとは別のsession-evidence照合値です。

| 結果 | 意味 |
|---|---|
| `accepted` / `duplicate` | 対が揃い、digestが一致 |
| `unknown unverified_error { code }` | `tool/result` が error（`EVENT_CONFLICT`、`AIZIGN_OUTCOME_UNKNOWN` など）。DSHはerrorに`{name, code}`しか永続化せず（presentation metadataは成功valueのみ）、bindingを検証できない。`code`は診断用で、このbindingのrejectionとして採用しない |
| `unknown no_result` | `tool/call` はあるが `tool/result` がない（crash等）。後続の発話からは推測しない |
| `unknown meta_mismatch` | 別のidentityの結果、または metadata がない |
| `unknown bound_exceeded` | sourceが `maxEvents`（既定 10000）を超えるeventを返した。partialな証拠は返さない |
| `unknown aborted` | timeout（既定 10秒）または呼び出し側のabort |
| `absent` | このtoolの呼び出しがない |

`EvidenceSource` は構造的port（`readFrom(sessionId, fromSeq)`）で、DSHの `SessionPersistence` がそのまま満たします。session idはadapterの入力であり、coreへは渡りません。

## Harness-facing codes

| Code | 意味 |
|---|---|
| `AIZIGN_UNAVAILABLE` | preflightでbinaryに到達できない、または `hello` がerror |
| `AIZIGN_INCOMPATIBLE` | protocol versionが違う、またはcapabilityがない |
| `AIZIGN_OUTCOME_UNKNOWN` | 提出の結果が不明（無応答、garbage、2 frame、oversized、相関不一致、timeout、abort、`JOURNAL_OUTCOME_UNKNOWN`）。再送しない |
| `INVALID_SIGNAL` ほか | protocol / workflow codeをそのまま転送 |
| `INVALID_EXPECTATION` | plugin configのidentityが不正 |
