# Decoder conformance fixtures

Protocol v1のdecoder実装（現在はRust、TypeScript）が同じfileを読んで同じ
acceptance / rejection判定をするためのfixtureです。wire contractの正本は
[`spec/protocol/v1/`](../protocol/v1/README.md)。ここはdecoder判定例であり、
client-side encoderのtyped inputではありません。

```text
spec/conformance/
├── valid/
│   ├── request/<name>.frame            decoderが受理すべきrequest frame
│   └── response/<name>.frame           decoderが受理すべきresponse frame
└── invalid/
    ├── request/<name>.frame            拒否すべきrequest frame
    ├── request/<name>.expect.json      code、復元correlation、response stage/version
    ├── response/<name>.frame           拒否すべきresponse frame
    └── response/<name>.expect.json     code、復元correlation、expected stage/version
```

## `.frame`

wireに流れるbytesそのもの（末尾の改行なし）。validなframeは1行のJSON。invalidなframeはJSONでなくてもよい。

## `.expect.json`（invalidのみ）

```json
{
  "code": "PROTOCOL_VERSION_UNSUPPORTED",
  "requestId": "req-future-01",
  "kind": "workflow.future",
  "responseStage": "bootstrap",
  "responseVersion": 1,
  "schema": false
}
```

| Field | request | response | 意味 |
|---|---|---|---|
| `code` | 必須 | 必須 | decoderが返すstable error code |
| `requestId` | 必須（`string` or `null`） | 必須（`string` or `null`） | 復元できるべき `requestId`。`null` は復元不可を要求する |
| `kind` | 必須（`string` or `null`） | 必須（`string` or `null`） | 復元できるべき `kind`。registrationは要求しない |
| `responseStage` | 必須 | 必須 | language-neutralな `bootstrap` または `accepted-operation`。requestではfailure responseのselected stage、responseではdecoderへ与えるexpected stage |
| `responseVersion` | 必須 | 必須 | selected/expected stageのexact numeric envelope version |
| `schema` | 必須 | 必須 | JSON Schemaが同じfolded JSON valueを受理するか。schema外lexical ruleは`true`になり得る |

## 実装が満たすこと

- `valid/request`: decodeが成功し、decodeした値をencodeし直すとframeとJSONとして等しい
- `valid/response`: 同上
- `invalid/request`: decodeが失敗し、code、復元された `requestId` / `kind`、およびprocess profileが選ぶfailure response stage/versionが一致する
- `invalid/response`: 指定されたexpected stage/versionでdecodeが失敗し、codeと復元された `requestId` / `kind` が一致する

上のdecode → encode比較は、request / responseの両decoderとencoderを持つfull
codec向けround-trip検査です。request decoderを持たないclient adapterへ
`valid/request`をencoder fixtureとして要求しません。

`valid/response/hello-future-operation-version.frame`はbootstrap envelope v1の
helloがoperation Protocol v2をadvertiseできることを固定します。両codecはこの
stable bootstrap shapeをdecodeしてから、client compatibility層でoperation version
を拒否します。

## Issue #77 lexical, probe, and future-version families

The shared request and response fixtures must cover the complete
[Protocol decode pipeline](../protocol/v1/README.md#version-independent-lexical-and-decode-pipeline)
without using either production implementation as the oracle. Required
families include:

- `1e400`, `-1e400`, `-0`, `1.0`, `1e0`, very long positive and negative
  canonical integers, `4294967295`, and `4294967296` at envelope and applicable
  payload locations;
- a very long canonical payload integer under an unsupported version
  (`PROTOCOL_VERSION_UNSUPPORTED`) and under the accepted version (the pinned
  payload-range failure);
- unsupported bootstrap hello and unsupported submit/reconcile operation
  versions, each with the recovered correlation and bootstrap-v1 failure
  response stage;
- an unregistered non-hello kind under unsupported operation version
  (`PROTOCOL_VERSION_UNSUPPORTED`) and accepted operation version
  (`UNKNOWN_KIND` under that accepted stage);
- a future version combined separately with an invalid request ID, missing
  response `ok`, unknown current-version field, current-version-invalid
  payload, and malformed nested error;
- bootstrap-v1 pre-operation/profile errors decoded by an operation client;
- a lexical defect combined with a future version, proving that source-order
  lexical failure and bootstrap-v1 failure representation still win; and
- duplicate/Unicode defects inside and outside probed fields, proving the
  final-readable-spelling correlation recovery rule.

Fixtures pin exact code, recovered `requestId`, recovered `kind`, and
source-qualified response stage/version. They do not pin diagnostic message or
semantic outcome classification. Focused mutation sentinels must fail if raw
numbers are coerced before inspection; kind membership moves before axis
selection; typed response decoding moves before the process-profile selector;
request-side response stage is discarded; or response failure correlation is
lost.

Issue #77 S1 records this target representation and inventory only. Existing
response expectations do not yet carry all required correlation/stage fields,
and the complete fixture families do not yet exist. Issue #77 S2 owns their
atomic addition with both codec migrations.

## Encoder conformance

directional client encoderは、このdirectoryのframe fixtureではなく
[`encoder-scenarios.md`](encoder-scenarios.md)に従います。Protocol v1 exampleを
generic test dataとして読み、production decoderなしでoutbound DTOを組み立て、
encode結果、schema、frame bound、local pre-transport failureを検査します。

## 検査

- `cargo xtask conformance`: 構造（`.frame` と `.expect.json` の対応、codeの形式、validがJSONであること）
- `crates/aizign-protocol/tests/conformance.rs`: Rust decoderで全件（loaderは `aizign-testkit::conformance`）
- `packages/protocol`: TypeScript decoderで全件（後続）

fixtureは架空のnon-confidentialな値だけを使い、実際のpath、ID、本文を含めません。
