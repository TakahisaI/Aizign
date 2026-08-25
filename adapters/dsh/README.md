# @aizign/adapter-dsh

The DSH harness adapter: a cordis plugin that registers one **scope-bound** `submit_workflow_signal` tool backed by the `aizign` binary over Protocol v1.

| | |
|---|---|
| **Responsibility** | DSH plugin entry（`name` / `inject` / `Config` / `apply`）、model-visible tool用preflight（`aizign hello` → protocol version + submit capability）、`OneShotCoreClient`、agentの引数 → `workflow.signal.submit` payload のmapping、control-plane向けread-only reconciliation clientとその独立したcapability requirement、coreの結果 → tool result / `HarnessError`、harness-persisted success metadata integration（`tool/result` の `meta` にbinding / payload digestを記録し、session logのcold readでbinding digestを照合） |
| **Non-responsibility** | 判断（core）、journal（coreのJSONL。DSH persistenceには書かない）、identityの決定（configで固定。agentは知らない）、live smokeの手順（operatorの `op/`） |
| **Inputs** | plugin config（binary、stateDir、timeoutMs、eventId + workflow / assignment / attempt / candidate digest）、agentのtool call `{ kind, findingCount?, artifactRef?, shortErrorCode? }` |
| **Outputs** | model tool result `{ disposition: accepted \| duplicate, eventId }`、control-plane reconciliation outcome、または `HarnessError`（protocol / workflow code、`AIZIGN_OUTCOME_UNKNOWN`、`AIZIGN_UNAVAILABLE`、`AIZIGN_INCOMPATIBLE`） |
| **Hard invariants** | control-plane identity（eventId、workflowId、assignmentId、attemptId、role、artifactRevision、candidateDigest）をtool schema・引数・promptに出さない（5、8）、reconciliationをmodel-visible toolにしない、DSHのcall id / session idを **envelope全体**（`requestId` 含む）に入れない（8。`requestId` はadapter所有のnonce）、responseは `requestId` / `kind` / `eventId` を送信と照合し不一致は `unknown`、reconciliation error codeは相関検査前に診断用`reportedCode`へ保持、stdoutは `MAX_FRAME_BYTES` と「frame 1つ」でbound、`unknown` は成功 / 失敗に縮約せず再送しない（3、4）、session readはcallerのtimeoutと取得後の`maxEvents` guardを持ちpartial evidenceを採用しない、preflight失敗時はtoolを登録しない、環境変数を子processへ丸ごと渡さない（PATHのみ） |
| **Allowed dependencies** | `@aizign/protocol`。peer: `@deepseek-ai/cordis` 4.0.1、`dsh-llm` / `dsh-tools` 0.1.1-rc.2、`schemastery` 3.18.1（exact、ADR-0010）。dev: `@aizign/adapter-testkit` |
| **Test command** | `npm test -w @aizign/adapter-dsh`（`AIZIGN_BINARY` を与えると実binaryにも） |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0010](../../docs/adr/0010-harness-sdk-dependencies-and-node-policy.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md) |

## Security boundary

Production plugin configuration is a trusted control-plane input after local
shape validation. `createClient()` does not inherit the harness environment:
the child receives `PATH` only. The exported reference client can accept
explicit child variables for tests/integration, and those values are the direct
caller's responsibility. Closed tool arguments prevent the model from choosing
stable identity, but neither the core nor schema can prove honest provenance
from a malicious adapter. DSH persistence remains auxiliary evidence with the
limits below. See the
[v0.1 threat model](../../docs/security/threat-model.md).

## Layout

```text
src/
├── index.ts                       plugin entry: name / inject / Config / apply、createClient
├── config.ts                      Config（schemastery）、validateConfig、SignalBinding、bindingPayload
├── core-client/one-shot-client.ts OneShotCoreClient（submit / reconcile、spawn → 1 frame → 1 frame、相関照合、frame bound、abort、unknownの分類）
├── mapping/tool.ts                createSubmitWorkflowSignalTool、decodeArgs、toPayload、toToolResult、presentationMetaFor、adapterCodes
├── lifecycle/preflight.ts         hello → checkCompatibility
└── evidence/
    ├── digest.ts                  canonicalJson、bindingDigest、payloadDigest（sha256）
    └── cold-read.ts               readSignalEvidence(source, sessionId, binding, { fromSeq, maxEvents, timeoutMs, signal }): caller timeout + post-read event guard
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
    stateDir: /path/to/runtime/aizign-state   # submit writerはfresh storeをdurable初期化。reconcileはmissingを作らずunknown
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

## Capability classification

This adapter satisfies the current minimum signal-submission behavior through
protocol preflight, trusted config-bound identity injection, full response
correlation, exact outcome propagation, non-collapse of `unknown`,
metadata-only requests, and bounded process I/O.

It also demonstrates three optional harness adapter integrations:

- harness-persisted success metadata integration;
- caller-wait timeout with a post-read event-count guard; and
- binding-digest verification with payload-digest recording.

These optional integrations are DSH-owned and do not define a generic adapter
event shape. An adapter without harness persistence or cold read can still
satisfy the minimum signal-submission behavior. A DSH error record without
verifiable binding metadata remains `unknown / unverified_error`; persistence
alone does not make it a rejection for the requested binding. The repository's
fake-DSH tests do not establish a durability or retention contract for real DSH
persistence across restart.

The session source returns an already-materialized event array. The timeout
bounds caller wait, and `maxEvents` rejects an oversized result after the read;
this API does not bound source-side I/O, allocation, event byte size, or work
that continues when a source ignores cancellation. The reader verifies
`eventId` and `bindingDigest`. It records and returns `payloadDigest` but does not
recompute it during cold read.

A non-abort rejection from `EvidenceSource.readFrom()` rejects the
`readSignalEvidence()` operation instead of producing a `SignalEvidence` value.
Callers must treat the observation as unavailable/unknown and must not infer
success, rejection, or absence from that failure.

`workflow.signal.reconcile` is a separate core protocol capability and performs
a bounded read-only lookup of the Aizign journal. It is not one of the DSH
harness-evidence integrations above. Submit and reconciliation preflight remain
independent.

Interrupt, effect dispatch, resource release, ownership, general lifecycle, and
remote reconnect are provisional inventory, not implemented DSH capabilities or
stable tokens.

## Evidence

completionの正本はjournal（core側）です。adapterはそれに加えて、toolの `presentationMeta` でharness-persisted `tool/result` eventの `meta` に
`{ tool, eventId, disposition, bindingDigest, payloadDigest }` を書きます。`readSignalEvidence` はsession logを cold read し、
最後の `tool/call`（このtool）と対になる `tool/result` を探して、`eventId` と `bindingDigest` を plugin config から再計算した値と照合します。`payloadDigest`は記録・返却しますがcold readでは再計算しません。adapter-localなbinding digestにはattemptとcandidate digestも含まれますが、Protocol v1の`candidateDigest`やcandidate bytesのauthorityとは別のsession-evidence照合値です。

| 結果 | 意味 |
|---|---|
| `accepted` / `duplicate` | 対が揃い、event IDとbinding digestが一致。payload digestは観測値であり、このreadでは検証しない |
| `unknown unverified_error { code }` | `tool/result` が error（`EVENT_CONFLICT`、`AIZIGN_OUTCOME_UNKNOWN` など）。DSHはerrorに`{name, code}`しか永続化せず（presentation metadataは成功valueのみ）、bindingを検証できない。`code`は診断用で、このbindingのrejectionとして採用しない |
| `unknown no_result` | `tool/call` はあるが `tool/result` がない（crash等）。後続の発話からは推測しない |
| `unknown meta_mismatch` | 別のidentityの結果、または metadata がない |
| `unknown bound_exceeded` | materialize済み配列が `maxEvents`（既定10000）を超えた。partialな証拠は返さない |
| `unknown aborted` | caller waitのtimeout（既定10秒）または呼び出し側のabort。sourceがcancelを無視した場合の継続処理までは停止保証しない |
| `absent` | このtoolの呼び出しがない |

`EvidenceSource` は構造的port（`readFrom(sessionId, fromSeq)`）で、DSHの `SessionPersistence` がそのまま満たします。現在のportにlimit / pagination / maximum bytesはなく、event-count guardは配列取得後に適用されます。session idはadapterの入力であり、coreへは渡りません。

`apply()` が登録するのはsubmit toolだけなので、そのpreflightが要求するcapabilityも `workflow.signal.submit` だけです。exportされた `OneShotCoreClient.reconcileWorkflowSignal()` をcontrol planeから直接使う場合は、`hello()` と `RECONCILIATION_REQUIRED` / `checkCompatibility()` で `workflow.signal.reconcile` を独立に確認します。reconciliation capabilityがないことを理由にsubmit toolまで非公開にはしません。

## Opt-in timing

`OneShotCoreClient`は`CoreClientConfig.timingSink`、`preflight`は`PreflightOptions.timingSink`、`readSignalEvidence`は`ColdReadOptions.timingSink`がある場合だけmetadata-only timingを通知します。
preflightは全体の`preflight_ms`、evidence cold readは`harness_cold_read_ms`と返されたevent数を記録します。
どのmeasurementにもsession ID、signal identity、path、本文を含めません。
同期throwと非同期Promise rejectionを共通helperで隔離するため、sink failureはtool登録、submit、reconcile、evidence classificationを変えません。

## Harness-facing codes

| Code | 意味 |
|---|---|
| `AIZIGN_UNAVAILABLE` | preflightでbinaryに到達できない、または `hello` がerror |
| `AIZIGN_INCOMPATIBLE` | protocol versionが違う、またはcapabilityがない |
| `AIZIGN_OUTCOME_UNKNOWN` | 提出の結果が不明（無応答、garbage、2 frame、oversized、相関不一致、timeout、abort、`JOURNAL_OUTCOME_UNKNOWN`）。再送しない |
| `INVALID_SIGNAL` ほか | protocol / workflow codeをそのまま転送 |
| `INVALID_EXPECTATION` | plugin configの検証に失敗 |
