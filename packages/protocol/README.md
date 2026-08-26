# @aizign/protocol

Aizign Protocol v1 reference layer for TypeScript: closed NDJSON envelope
codec, `hello` compatibility, and a submit/reconcile `CoreClient` convenience
interface.

| | |
|---|---|
| **Responsibility** | `decodeRequest` / `encodeRequest` / `decodeResponse` / `encodeResponse`（両方向 `MAX_FRAME_BYTES`）、`extractFrame`（完全なstdoutがframe 1つだけか）、`OneShotFrameCollector`（LFまでのframeをboundedに保持し末尾ASCII whitespaceを保存せず検査）、`checkCorrelation`（`requestId` / `kind` / `eventId` の照合）、`hello` の `checkCompatibility`、submit / reconcileのpayload型とclosed decoder、`CoreClient` / submit・reconcile outcomeの契約型 |
| **Non-responsibility** | process起動・environment・timeout・preflight・parent timing、filesystem、harness固有型、判断（coreの責務。decoderはcoreと同じ入力規則で **事前に** 拒否するだけ） |
| **Inputs** | frame（`Uint8Array` / `string`）、payload object |
| **Outputs** | `Request` / `Response`、`DecodeFailure`（復元した `requestId` / `kind` 付き）、`ProtocolError` |
| **Hard invariants** | BOMなしUTF-8、well-formed Unicode、closed schema（未知field、`null`、未登録kindを拒否）、submit / reconcileのsignalをRustと同じ規則でdecode、`spec/conformance` の全fixtureでRust実装と同じcodeと復元IDを返す、reconciliationの全failureは`unknown`、valid error codeは相関検査より先に`reportedCode`へ保持、blind retryしない |
| **Allowed dependencies** | なし（runtime）。dev: workspace rootの `typescript` / `@biomejs/biome` / `@types/node` |
| **Test command** | `npm test -w @aizign/protocol`（`node --test`、型はNodeがstripする） |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0004](../../docs/adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md)、[0020](../../docs/adr/0020-narrow-typescript-exports-and-own-dsh-transport.md) |

## Security boundary

The TypeScript codec enforces Protocol v1 shape, lexical rules, and frame
bounds. It does not authenticate a peer, establish identity/digest provenance,
or detect sensitive content hidden in an allowed opaque string. See the
[v0.1 threat model](../../docs/security/threat-model.md).

wire contractの正本は [`spec/protocol/v1/`](../../spec/protocol/v1/README.md)、
言語中立のadapter behaviorの正本は
[`harness-adapter-contract.md`](../../docs/architecture/harness-adapter-contract.md)です。
このpackageはそれらに従うTypeScript reference layerであり、全adapterの必須dependencyではありません。

## Layout

```text
src/
├── index.ts              closed exports
├── envelope.ts           decode / encode（duplicate member走査 → lenient probe → strict envelope → kind dispatch）
├── duplicate-member.ts   member重複とUnicode stringのlexical走査（内部実装）
├── error.ts              ProtocolError、codes、SHORT_ERROR_CODE_PATTERN
├── hello.ts              HelloInfo、decodeHelloInfo、checkCompatibility
├── workflow-signal.ts    shared signal、submit / reconcile payload、result decoder
├── client.ts             Node-free CoreClient、correlation、Hello / Submit / ReconcileOutcome、current classification helpers
├── shape.ts              isPlainObject、assertOnlyKeys、IDENTIFIER_PATTERN
└── *.test.ts             conformance（spec/conformance全件）、hello、envelope
```

## 使い方

```ts
import { checkCompatibility, decodeResponse, encodeRequest, PROTOCOL_VERSION } from '@aizign/protocol';

const frame = encodeRequest({ requestId: 'req-1', kind: 'hello' });
const response = decodeResponse(lineFromStdout);
if (response.body.type === 'hello') {
  const problem = checkCompatibility(response.body.info, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: ['workflow.signal.submit', 'workflow.signal.reconcile'],
  });
}
```

TypeScript adapterがこの `CoreClient` を選ぶ場合、その実装はadapterが所有します。
このinterfaceはsubmissionとreconciliationのoperation surfaceを含むTypeScript
referenceです。実装したことだけでは、trusted identity provenance、model-visible
schema、native registration / preflightを含むharness-adapter conformanceは証明
されません。`reconcileWorkflowSignal`はsuccessを
`accepted | conflict | absent`へ写像し、error / transport / decode / timeout /
abort / correlation failureを`unknown`へ写像します。responseにvalidなerror
codeがあれば、相関しないwatchdog responseでも診断用`reportedCode`として保持
します。TypeScriptでのclient boundary検証には
[`@aizign/adapter-testkit`](../adapter-testkit/README.md)を使えます。

outbound requestが `MAX_REQUEST_BYTES` を超える場合、`CoreClient` Promiseは
process spawn前に `ProtocolError(REQUEST_TOO_LARGE)` でrejectします。これはcoreの
`rejected`でもtransport後の`unknown`でもなく、`SubmitOutcome`を生成しないlocal
failureです。

Process configuration, preflight, and parent timing are owned by the DSH
adapter and are not Protocol exports. Repository control-plane consumers use
the closed provisional
`@aizign/adapter-dsh/experimental/transport` subpath. Parent timing remains
source-qualified operational evidence rather than Protocol v1 or stable
package compatibility. The
[classification contract](../../spec/classification/README.md) remains the
target cross-language authority; Issue #75 owns the later corpus/consumer
migration.

The root runtime and declaration exports are exact allowlists verified by
`spec/test/package-exports.test.mjs`. Deep `src/` or generated `lib/` imports
are not supported.
