# @aizign/adapter-testkit

Apply language-neutral `CoreClient` scenarios to a supplied production client
against a fake core — including every way an outcome can be **unknown** —
without a harness or a network.

| | |
|---|---|
| **Responsibility** | fake core process（Protocol v1、JSON state、fault injection）、`runCoreScenarios`（fakeでも実binaryでも）、内部fault scenarioを含む`runCoreClientConformance`、`assertMetadataOnly`、`samplePayload` |
| **Non-responsibility** | production core client、process/timing policy、harness固有のfake（すべてadapter側が持つ） |
| **Inputs** | `CoreClientFactory`（testkit-owned `CoreClientFixtureConfig` → Protocol `CoreClient`） |
| **Outputs** | `node:assert` による検証。違反で例外 |
| **Hard invariants** | supplied production clientに対してno-response / garbage / invalid UTF-8 / hang / `JOURNAL_OUTCOME_UNKNOWN` / 未認識だが正形式のpeer code / spawn失敗を **すべて `unknown`** と検査する（成功にも失敗にも縮約しない、再送しない）、submit / reconciliationの相関不一致でもerror codeを診断用`reportedCode`として保持、reconciliationのaccepted / conflict / absentを検証、lost acknowledgement後もblind submit retryしない、harness IDや本文がframeに現れない |
| **Allowed dependencies** | `@aizign/protocol` |
| **Test command** | `npm test -w @aizign/adapter-testkit` |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md)、[0020](../../docs/adr/0020-narrow-typescript-exports-and-own-dsh-transport.md) |

## Security boundary

This package supplies regression evidence, not runtime enforcement or a proof
of end-to-end adapter security. Its fake state is not a durability or
authenticity boundary, and generic metadata-key scanning cannot prove value
provenance. Each adapter owns native identity, visible-schema, configuration,
and environment-isolation tests. See the
[v0.1 threat model](../../docs/security/threat-model.md).

言語中立のscenario requirementは
[`harness-adapter-contract.md`](../../docs/architecture/harness-adapter-contract.md)
が所有します。このpackageはTypeScript test convenience layerであり、
全adapterに共通の実行可能interfaceではありません。現在のrunnerはsubmitと
reconcileのcore-client operation surfaceを検査します。runnerの通過だけでは、
identity provenance、model-visible schema、native registration / preflightなどの
harness-adapter conformanceは証明されません。非TypeScript adapterは同じfixtureと
適用対象scenarioをその言語のrunnerで検証できます。

## Layout

```text
src/
├── index.ts
├── fake-core.ts           node fake-core.js hello | handle --state <dir>。submit / reconcile stateとfault injection
├── fake-core-path.ts      fakeCoreCommand(): { command: process.execPath, args: [fake-core] }
├── conformance.ts         runCoreScenarios / runFaultScenarios / runCoreClientConformance、samplePayload、assertMetadataOnly
└── conformance.test.ts    testkit-owned assertionのunit test
```

`cargo xtask npm-check` は `x86_64-unknown-linux-gnu` 上で `aizign` をbuildして
`AIZIGN_BINARY` をDSH conformanceへ渡します。production
`OneShotCoreClient` ↔ 実binary ↔ JSONL journal の往復が通常の検査に含まれます。
未検証storage targetでは実binary scenarioをskipし、x86_64 GNU/Linux CIを正本とします。

## adapterからの使い方

```ts
import { test } from 'node:test';
import { runCoreClientConformance } from '@aizign/adapter-testkit';
import { MyCoreClient } from '../src/core-client/index.ts';

test('core client conformance', async () => {
  await runCoreClientConformance((config) => new MyCoreClient(config));
});
```

runnerが検査する経路:

| Scenario | 期待 |
|---|---|
| `hello` | `ok`、`protocolVersion === 1`、capabilityにsubmitとreconcile |
| submit → 同じsignal → 内容違い | `accepted` → `duplicate` → `rejected EVENT_CONFLICT` |
| accepted signal / changed content / missing eventをreconcile | `accepted` / `conflict` / `absent` |
| attempt / revision / candidate digest expectation違い | 対応する`*_MISMATCH` |
| 別eventで同じrevision identifier・異candidate digest（expected / signalは一致） | `accepted`（global registryを持たない） |
| processがframeなしで終了 / exit 2 | `unknown no_response` |
| stdoutがframeでない | `unknown undecodable_response` |
| stdoutのframeに生の不正UTF-8 byteがある | byte列のままfatal decodeし`unknown undecodable_response`。既知rejectionへ縮約せずretryなし |
| coreが `JOURNAL_OUTCOME_UNKNOWN` を返す | `unknown reported_unknown` |
| coreが未認識だが正形式のerror codeを返す | `unknown reported_unknown` + diagnostic `reportedCode`。`rejected`へ縮約せずretryなし |
| 未認識codeを持つerror responseの`requestId`が不一致 | `unknown correlation_mismatch` + diagnostic `reportedCode`。raw codeはtimingへ出さずretryなし |
| lost acknowledgement後にfresh clientでreconcile | `accepted`。submitは1回だけでblind retryなし |
| `requestId: null` / `kind: null` / `HANDLER_TIMEOUT` watchdog response | `unknown correlation_mismatch` + `reportedCode: HANDLER_TIMEOUT` |
| 応答なし（timeout） | `unknown timeout` |
| 呼び出し側のabort | `unknown aborted` |
| `requestId` / `kind` / `eventId` が送信と一致しない | `unknown correlation_mismatch` |
| responseが `MAX_FRAME_BYTES` を超える | `unknown oversized_response`（childをkill） |
| frame本体がちょうど `MAX_FRAME_BYTES` で、LF後にASCII whitespaceがある | frameを受理して通常分類（末尾whitespaceは保持しない） |
| outbound requestが `MAX_REQUEST_BYTES` を超える | spawn前に `REQUEST_TOO_LARGE`でPromise reject。spawn 0回・request 0件・submit classificationなし |
| reconciliationが `absent` | reconcile request 1件だけ。implicit submitなし |
| stdoutにframeが2つ、または末尾に非whitespace | `unknown undecodable_response` |
| binaryが存在しない | `unknown spawn_failed` |

fake coreは受け取ったframeを `<state>/fake-requests.jsonl` に残します。
`readFakeRequests(stateDir)` でcomplete envelopeを読み、harness-native testから検査
できます。`assertMetadataOnly` は `callId` / `sessionId` / `providerId` /
`deliveryId` など既知の禁止keyを走査するconvenience assertionに限られ、値の
provenanceまでは証明しません。adapter側は、実際のnative ID値がcaptured envelope
のどこにも現れないことと、`requestId`がadapter-owned nonceであることを別途検査
します。

このpackageはparent timingを定義・検査しません。DSH固有のtiming shape、code
disclosure、sink isolationはproduction `OneShotCoreClient`のDSH testsが所有します。
`runFaultScenarios`と`FORBIDDEN_KEYS`はroot exportではなく、公開runner/assertionの
内部実装です。root runtime/type exportはexact allowlistであり、deep importは
supportされません。
