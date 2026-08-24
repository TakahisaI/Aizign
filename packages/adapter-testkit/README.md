# @aizign/adapter-testkit

Prove a harness adapter's core client against a fake core — including every way an outcome can be **unknown** — without the real `aizign` binary, a harness, or a network.

| | |
|---|---|
| **Responsibility** | fake core process（Protocol v1、JSON state、fault injection）、`runCoreScenarios`（fakeでも実binaryでも）、`runFaultScenarios`（fakeのみ）、`runCoreClientConformance`（両方）、`ReferenceOneShotClient`（参照実装）、`assertMetadataOnly`、`samplePayload` |
| **Non-responsibility** | 本番でのcore client（adapterが所有）、harness固有のfake（adapter側の `test/` が持つ） |
| **Inputs** | `CoreClientFactory`（`CoreClientConfig` → `CoreClient`） |
| **Outputs** | `node:assert` による検証。違反で例外 |
| **Hard invariants** | no-response / garbage / hang / `JOURNAL_OUTCOME_UNKNOWN` / spawn失敗は **すべて `unknown`**（成功にも失敗にも縮約しない、再送しない）、reconciliationのaccepted / conflict / absentと`reportedCode`を検証、lost acknowledgement後もblind submit retryしない、harness IDや本文がframeに現れない |
| **Allowed dependencies** | `@aizign/protocol` |
| **Test command** | `npm test -w @aizign/adapter-testkit` |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md) |

## Layout

```text
src/
├── index.ts
├── fake-core.ts           node fake-core.js hello | handle --state <dir>。submit / reconcile stateとfault injection
├── fake-core-path.ts      fakeCoreCommand(): { command: process.execPath, args: [fake-core] }
├── reference-client.ts    ReferenceOneShotClient: spawn → 1 frame → 1 frame → unknownの分類
├── conformance.ts         runCoreScenarios / runFaultScenarios / runCoreClientConformance、samplePayload、assertMetadataOnly
├── reference-client.test.ts   fake coreに対する全scenario
└── real-binary.test.ts        AIZIGN_BINARY が指す実binaryに対する core scenario（未設定ならskip）
```

`cargo xtask npm-check` はLinux上で `aizign` をbuildして `AIZIGN_BINARY` を渡すので、TypeScript client ↔ 実binary ↔ JSONL journal の往復も通常の検査に含まれます。未検証storage targetでは実binary scenarioをskipし、Linux CIを正本とします。

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
| coreが `JOURNAL_OUTCOME_UNKNOWN` を返す | `unknown reported_unknown` |
| lost acknowledgement後にfresh clientでreconcile | `accepted`。submitは1回だけでblind retryなし |
| `requestId: null` / `kind: null` / `HANDLER_TIMEOUT` watchdog response | `unknown correlation_mismatch` + `reportedCode: HANDLER_TIMEOUT` |
| 応答なし（timeout） | `unknown timeout` |
| 呼び出し側のabort | `unknown aborted` |
| `requestId` / `kind` / `eventId` が送信と一致しない | `unknown correlation_mismatch` |
| responseが `MAX_FRAME_BYTES` を超える | `unknown oversized_response`（childをkill） |
| stdoutにframeが2つ、または末尾に非whitespace | `unknown undecodable_response` |
| binaryが存在しない | `unknown spawn_failed` |

fake coreは受け取ったframeを `<state>/fake-requests.jsonl` に残します。`readFakeRequests(stateDir)` で読み、`assertMetadataOnly` を **envelope全体** に適用すれば、payloadだけでなく `requestId` にもharness IDが混入していないことを検査できます（`FORBIDDEN_KEYS` には `callId` / `sessionId` を含む）。
