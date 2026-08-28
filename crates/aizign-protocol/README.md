# aizign-protocol

Aizign Protocol v1: NDJSON envelopes, closed decoders, and explicit DTO ↔ domain conversion.

| | |
|---|---|
| **Responsibility** | request / response envelope、protocol version、`hello`、kindごとのpayload decode / encode、stable error code、input size制限、DTO ↔ `aizign-core` 型の変換 |
| **Non-responsibility** | process起動、stdin / stdoutの読み書き（`aizign-cli`）、journal、判断（`aizign-core`）、harness固有型 |
| **Inputs** | 1 request frame（bytes）、または `aizign-core` の `Command` / `Decision` 由来の結果 |
| **Outputs** | `Request`（`RequestKind::Hello` / `SubmitWorkflowSignal(Command)` / `ReconcileWorkflowSignal(WorkflowSignal)`）、bound内のrequest / response JSON、またはencode error |
| **Hard invariants** | closed schema（未知field、`null`、未登録kindを拒否）、submitとreconcileで同じsignal DTO / validationを使う、attempt / typed candidate digest shapeをdomain型へ明示変換、encoderはboundを超えるrequest / responseを生成しない、stdoutに出るのはresponse 1行だけ（改行をescape）、messageにrequest本文を含めない、`accepted` はwriter-published committed stateだけから作られる（engineの責務。このcrateは結果をencodeするだけ） |
| **Allowed dependencies** | `aizign-core`、`serde`、`serde_json`（ADR-0009） |
| **Test command** | `cargo test -p aizign-protocol` |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0004](../../docs/adr/0004-separate-domain-protocol-journal-and-adapter-schemas.md)、[0009](../../docs/adr/0009-serialization-dependencies-for-the-protocol-crate.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md)、[0023](../../docs/adr/0023-define-protocol-lexical-and-outbound-validation-boundaries.md) |

## Security boundary

Closed decoding and bounded encoding enforce Protocol v1 shape and lexical
rules. They do not authenticate the sender, prove candidate-digest provenance,
or detect sensitive content placed in an otherwise allowed opaque string. See
the [v0.1 threat model](../../docs/security/threat-model.md).

wire contractの正本は [`spec/protocol/v1/`](../../spec/protocol/v1/README.md)。このcrateはそれに従う側です。

## Layout

```text
src/
├── lib.rs              意図した型だけを公開
├── envelope.rs         Request / Response、decode_request / encode_request / decode_response / encode_response
├── error.rs            ProtocolError、codes::*
├── hello.rs            HelloInfo、PackageInfo、capability定数
├── json_token.rs       duplicate member・Unicode・canonical integerの単一raw-token走査（内部実装）
└── workflow_signal.rs  submit / reconcileのshared signal DTO（private）と変換、各result / disposition
tests/
├── examples.rs         spec/protocol/v1/examples の全fileをdecode → encodeで往復
├── closed_decoder.rs   size、envelope、version、kind、payloadの各拒否経路とcode
└── conformance.rs      spec/conformance の全fixture（TypeScript実装と同じfile）
```

## Decode の段階

1. size（`MAX_REQUEST_BYTES`）→ `REQUEST_TOO_LARGE`
2. BOMなしUTF-8とwell-formed Unicode → 違反は `INVALID_ENVELOPE`
3. source-order raw-token走査（duplicate member、Unicode scalar、canonical integer）
4. lossless lenient probe: `protocol`、raw `version`、`requestId`、`kind`
5. kind axisとversionを選択し、unsupportedならbootstrap-v1 response contextを保持
6. accepted-version strict envelope（`deny_unknown_fields`、payloadはobject）
7. kind dispatch → `UNKNOWN_KIND` / `INVALID_PAYLOAD` / `INVALID_EXPECTATION` / workflow code

`DecodeFailure` は復元できた `request_id` / `kind` とsource-qualified response
version contextを保持します。`ProtocolError::try_new` はmalformed codeを拒否し、
well-formedな未認識codeは保持します。
