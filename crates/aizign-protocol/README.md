# aizign-protocol

Aizign Protocol v1: NDJSON envelopes, closed decoders, and explicit DTO ↔ domain conversion.

| | |
|---|---|
| **Responsibility** | request / response envelope、protocol version、`hello`、kindごとのpayload decode / encode、stable error code、input size制限、DTO ↔ `aizign-core` 型の変換 |
| **Non-responsibility** | process起動、stdin / stdoutの読み書き（`aizign-cli`）、journal、判断（`aizign-core`）、harness固有型 |
| **Inputs** | 1 request frame（bytes）、または `aizign-core` の `Command` / `Decision` 由来の結果 |
| **Outputs** | `Request`（`RequestKind::Hello` / `SubmitWorkflowSignal(Command)`）、`Response`（1行のJSON） |
| **Hard invariants** | closed schema（未知field、`null`、未登録kindを拒否）、attempt / typed digest / causation shapeをdomain型へ明示変換、stdoutに出るのはresponse 1行だけ（改行をescape）、messageにrequest本文を含めない、`accepted` はdurable appendの後でしか作られない（engineの責務。このcrateは結果をencodeするだけ） |
| **Allowed dependencies** | `aizign-core`、`serde`、`serde_json`（ADR-0009） |
| **Test command** | `cargo test -p aizign-protocol` |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0004](../../docs/adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md)、[0009](../../docs/adr/0009-serialization-dependencies-for-the-protocol-crate.md) |

wire contractの正本は [`spec/protocol/v1/`](../../spec/protocol/v1/README.md)。このcrateはそれに従う側です。

## Layout

```text
src/
├── lib.rs              意図した型だけを公開
├── envelope.rs         Request / Response、decode_request / encode_request / decode_response / encode_response
├── error.rs            ProtocolError、codes::*
├── hello.rs            HelloInfo、PackageInfo、capability定数
├── json_member.rs      member重複の事前検査（内部実装）
└── workflow_signal.rs  workflow.signal.submit のDTO（private）と変換、SignalResult / Disposition
tests/
├── examples.rs         spec/protocol/v1/examples の全fileをdecode → encodeで往復
├── closed_decoder.rs   size、envelope、version、kind、payloadの各拒否経路とcode
└── conformance.rs      spec/conformance の全fixture（TypeScript実装と同じfile）
```

## Decode の段階

1. size（`MAX_REQUEST_BYTES`）→ `REQUEST_TOO_LARGE`
2. BOMなしUTF-8とwell-formed Unicode → 違反は `INVALID_ENVELOPE`
3. duplicate member走査（lexical。schemaで表現できず、streaming / folding parserで意味が分れるため）。相関データはfold後の値から復元する
4. lenient probe: `protocol`、`version`、`requestId`、`kind` だけを読む。versionが違えば `PROTOCOL_VERSION_UNSUPPORTED` を **requestId付きで** 返せる。versionが整数range `0..=u32::MAX` 外なら `INVALID_ENVELOPE`
5. strict envelope（`deny_unknown_fields`、payloadはobject）→ `INVALID_ENVELOPE`
6. kind dispatch → `UNKNOWN_KIND` / `INVALID_PAYLOAD` / `INVALID_EXPECTATION` / workflow code

`DecodeFailure` は復元できた `request_id` / `kind` を持つので、shellは常にaddressed responseを書けます。
