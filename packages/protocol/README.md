# @aizu/protocol

Aizu Protocol v1 for TypeScript: closed NDJSON envelope codec, `hello` compatibility, and the `CoreClient` contract every harness adapter implements.

| | |
|---|---|
| **Responsibility** | `decodeRequest` / `encodeRequest` / `decodeResponse` / `encodeResponse`（両方向 `MAX_FRAME_BYTES`）、`extractFrame`（stdoutがframe 1つだけか）、`checkCorrelation`（`requestId` / `kind` / `eventId` の照合）、`hello` の `checkCompatibility`、`workflow.signal.submit` のpayload型と closed decoder、`CoreClient` / `SubmitOutcome` / `UnknownOutcome` の契約型 |
| **Non-responsibility** | process起動、filesystem、harness固有型、判断（coreの責務。decoderはcoreと同じ入力規則で **事前に** 拒否するだけ） |
| **Inputs** | frame（`Uint8Array` / `string`）、payload object |
| **Outputs** | `Request` / `Response`、`DecodeFailure`（復元した `requestId` / `kind` 付き）、`ProtocolError` |
| **Hard invariants** | closed schema（未知field、`null`、未登録kindを拒否）、`spec/conformance` の全fixtureでRust実装と同じcodeと復元IDを返す、`JOURNAL_OUTCOME_UNKNOWN` / `HANDLER_TIMEOUT` は `rejected` ではなく `unknown` |
| **Allowed dependencies** | なし（runtime）。dev: workspace rootの `typescript` / `@biomejs/biome` / `@types/node` |
| **Test command** | `npm test -w @aizu/protocol`（`node --test`、型はNodeがstripする） |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0004](../../docs/adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md) |

wire contractの正本は [`spec/protocol/v1/`](../../spec/protocol/v1/README.md)。このpackageはそれに従う側です。

## Layout

```text
src/
├── index.ts              closed exports
├── envelope.ts           decode / encode（duplicate member走査 → lenient probe → strict envelope → kind dispatch）
├── duplicate-member.ts   member重複のlexical走査（内部実装）
├── error.ts              ProtocolError、codes、SHORT_ERROR_CODE_PATTERN
├── hello.ts              HelloInfo、decodeHelloInfo、checkCompatibility
├── workflow-signal.ts    payload型、decodeWorkflowSignalSubmit（coreと同じ規則）、decodeSignalResult
├── client.ts             CoreClient、CoreClientConfig、HelloOutcome、SubmitOutcome、UNKNOWN_OUTCOME_CODES
├── shape.ts              isPlainObject、assertOnlyKeys、IDENTIFIER_PATTERN
└── *.test.ts             conformance（spec/conformance全件）、hello、envelope
```

## 使い方

```ts
import { checkCompatibility, decodeResponse, encodeRequest, PROTOCOL_VERSION } from '@aizu/protocol';

const frame = encodeRequest({ requestId: 'req-1', kind: 'hello' });
const response = decodeResponse(lineFromStdout);
if (response.body.type === 'hello') {
  const problem = checkCompatibility(response.body.info, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: ['workflow.signal.submit'],
  });
}
```

`CoreClient` の実装は各adapterが所有します。検証には [`@aizu/adapter-testkit`](../adapter-testkit/README.md) を使います。
