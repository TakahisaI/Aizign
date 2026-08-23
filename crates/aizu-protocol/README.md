# aizu-protocol

Aizu Protocol v1: NDJSON envelopes, closed decoders, and explicit DTO ↔ domain conversion.

| | |
|---|---|
| **Responsibility** | request / response envelope、protocol version、`hello`、kindごとのpayload decode / encode、stable error code、input size制限、DTO ↔ `aizu-core` 型の変換 |
| **Non-responsibility** | process起動、stdin / stdoutの読み書き（`aizu-cli`）、journal、判断（`aizu-core`）、harness固有型 |
| **Inputs** | 1 request frame（bytes）、または `aizu-core` の `Command` / `Decision` 由来の結果 |
| **Outputs** | `Request`（`RequestKind::Hello` / `SubmitWorkflowSignal(Command)`）、`Response`（1行のJSON） |
| **Hard invariants** | closed schema（未知field、`null`、未登録kindを拒否）、stdoutに出るのはresponse 1行だけ（改行をescape）、messageにrequest本文を含めない、`accepted` はdurable appendの後でしか作られない（engineの責務。このcrateは結果をencodeするだけ） |
| **Allowed dependencies** | `aizu-core`、`serde`、`serde_json`（ADR-0009） |
| **Test command** | `cargo test -p aizu-protocol` |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0004](../../docs/adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md)、[0009](../../docs/adr/0009-serialization-dependencies-for-the-protocol-crate.md) |

wire contractの正本は [`spec/protocol/v1/`](../../spec/protocol/v1/README.md)。このcrateはそれに従う側です。

## Layout

```text
src/
├── lib.rs              意図した型だけを公開
├── envelope.rs         Request / Response、decode_request / encode_request / decode_response / encode_response
├── error.rs            ProtocolError、codes::*
├── hello.rs            HelloInfo、PackageInfo、capability定数
└── workflow_signal.rs  workflow.signal.submit のDTO（private）と変換、SignalResult / Disposition
tests/
├── examples.rs         spec/protocol/v1/examples の全fileをdecode → encodeで往復
└── closed_decoder.rs   size、envelope、version、kind、payloadの各拒否経路とcode
```

## Decode の段階

1. size（`MAX_REQUEST_BYTES`）→ `REQUEST_TOO_LARGE`
2. lenient probe: `protocol`、`version`、`requestId`、`kind` だけを読む。versionが違えば `PROTOCOL_VERSION_UNSUPPORTED` を **requestId付きで** 返せる
3. strict envelope（`deny_unknown_fields`、payloadはobject）→ `INVALID_ENVELOPE`
4. kind dispatch → `UNKNOWN_KIND` / `INVALID_PAYLOAD` / `INVALID_EXPECTATION` / workflow code

`DecodeFailure` は復元できた `request_id` / `kind` を持つので、shellは常にaddressed responseを書けます。
