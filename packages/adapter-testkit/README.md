# @aizu/adapter-testkit

Prove a harness adapter's core client against a fake core — including every way an outcome can be **unknown** — without the real `aizu` binary, a harness, or a network.

| | |
|---|---|
| **Responsibility** | fake core process（Protocol v1、JSON state、fault injection）、`runCoreScenarios`（fakeでも実binaryでも）、`runFaultScenarios`（fakeのみ）、`runCoreClientConformance`（両方）、`ReferenceOneShotClient`（参照実装）、`assertMetadataOnly`、`samplePayload` |
| **Non-responsibility** | 本番でのcore client（adapterが所有）、harness固有のfake（adapter側の `test/` が持つ） |
| **Inputs** | `CoreClientFactory`（`CoreClientConfig` → `CoreClient`） |
| **Outputs** | `node:assert` による検証。違反で例外 |
| **Hard invariants** | no-response / garbage / hang / `JOURNAL_OUTCOME_UNKNOWN` / spawn失敗は **すべて `unknown`**（成功にも失敗にも縮約しない、再送しない）、accepted → duplicate → conflict が別process間で成立、harness IDや本文がframeに現れない |
| **Allowed dependencies** | `@aizu/protocol` |
| **Test command** | `npm test -w @aizu/adapter-testkit` |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md) |

## Layout

```text
src/
├── index.ts
├── fake-core.ts           node fake-core.js hello | handle --state <dir>。AIZU_FAKE_FAULT = no-response | garbage | hang | journal-unknown | exit-2
├── fake-core-path.ts      fakeCoreCommand(): { command: process.execPath, args: [fake-core] }
├── reference-client.ts    ReferenceOneShotClient: spawn → 1 frame → 1 frame → unknownの分類
├── conformance.ts         runCoreScenarios / runFaultScenarios / runCoreClientConformance、samplePayload、assertMetadataOnly
├── reference-client.test.ts   fake coreに対する全scenario
└── real-binary.test.ts        AIZU_BINARY が指す実binaryに対する core scenario（未設定ならskip）
```

`cargo xtask npm-check` は `aizu` をbuildして `AIZU_BINARY` を渡すので、TypeScript client ↔ 実binary ↔ JSONL journal の往復も通常の検査に含まれます。

## adapterからの使い方

```ts
import { test } from 'node:test';
import { runCoreClientConformance } from '@aizu/adapter-testkit';
import { MyCoreClient } from '../src/core-client/index.ts';

test('core client conformance', async () => {
  await runCoreClientConformance((config) => new MyCoreClient(config));
});
```

runnerが検査する経路:

| Scenario | 期待 |
|---|---|
| `hello` | `ok`、`protocolVersion === 1`、capabilityに `workflow.signal.submit` |
| submit → 同じsignal → 内容違い | `accepted` → `duplicate` → `rejected EVENT_CONFLICT` |
| expectation違い | `rejected REVISION_MISMATCH` |
| processがframeなしで終了 / exit 2 | `unknown no_response` |
| stdoutがframeでない | `unknown undecodable_response` |
| coreが `JOURNAL_OUTCOME_UNKNOWN` を返す | `unknown reported_unknown` |
| 応答なし（timeout） | `unknown timeout` |
| binaryが存在しない | `unknown spawn_failed` |

fake coreは受け取ったframeを `<state>/fake-requests.jsonl` に残すので、adapterのmapping testは `assertMetadataOnly` でharness IDや本文の混入を検査できます。
