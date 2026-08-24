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
    ├── request/<name>.expect.json      期待するcodeと、復元されるべき requestId / kind
    ├── response/<name>.frame           拒否すべきresponse frame
    └── response/<name>.expect.json     期待するcode
```

## `.frame`

wireに流れるbytesそのもの（末尾の改行なし）。validなframeは1行のJSON。invalidなframeはJSONでなくてもよい。

## `.expect.json`（invalidのみ）

```json
{ "code": "PROTOCOL_VERSION_UNSUPPORTED", "requestId": "req-future-01", "kind": "hello" }
```

| Field | request | response | 意味 |
|---|---|---|---|
| `code` | 必須 | 必須 | decoderが返すstable error code |
| `requestId` | 必須（`string` or `null`） | — | 復元できるべき `requestId`。`null` は「復元できないこと」を要求する |
| `kind` | 必須（`string` or `null`） | — | 同上 |

## 実装が満たすこと

- `valid/request`: decodeが成功し、decodeした値をencodeし直すとframeとJSONとして等しい
- `valid/response`: 同上
- `invalid/request`: decodeが失敗し、codeが一致し、復元された `requestId` / `kind` が一致する
- `invalid/response`: decodeが失敗し、codeが一致する

上のdecode → encode比較は、request / responseの両decoderとencoderを持つfull
codec向けround-trip検査です。request decoderを持たないclient adapterへ
`valid/request`をencoder fixtureとして要求しません。

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
