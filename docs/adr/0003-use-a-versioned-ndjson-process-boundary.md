# ADR-0003: Use a versioned NDJSON process boundary

- Status: Accepted
- Date: 2026-08-23
- Related: ADR-0002, ADR-0004, ADR-0008

## Context

coreはRust（ADR-0002）、最初のharness adapterはTypeScriptである。両者の接続方式として、N-API binding、WASM、FFI、
subprocessのいずれかを選ぶ必要がある。coreとadapterの契約はまだ発展段階にあり、adapterの実装言語を限定したくない。
LLM処理に比べればprocess起動costは無視できる。

## Decision

- coreとadapterの間は **versioned NDJSON protocolによるprocess境界** とする。N-API、WASM、FFIは初期には採用しない。
- 初期transportは **one-shot subprocess**。adapterは `aizu handle --state <dir>` を起動し、stdinへ一つのrequestを送り、stdoutから一つのresponseを受け取る。処理後、processは終了する。
- envelopeは次の形を基本とする。

  ```json
  {"protocol": "aizu", "version": 1, "requestId": "req-01", "kind": "workflow.signal.submit", "payload": {}}
  ```

- protocolのルール:
  - stdoutにはprotocol response以外を出さない。logはstderrへ出す
  - raw prompt、model output、reasoningをlogへ出さない
  - 全messageをclosed schemaにする。未知fieldを黙って無視しない
  - 既存messageのshapeはrelease後に変更しない。新しい機能は新しい `kind` として追加する
  - envelopeや既存payloadの破壊的変更はprotocol versionを上げる
  - request size、record数、処理時間をboundedにする
  - `hello` commandでversionとcapabilityを事前確認する
  - 互換性はpackage semverの一致ではなく、protocol versionとcapabilityで判定する
- protocol versionはpackage versionとは独立した整数とする（ADR-0008）。
- 将来 `aizu serve`（persistent process）、N-API、WASM、local socketを追加してもよいが、すべて同じprotocol semanticsとconformance testを満たすこと。N-APIやWASMをdomain contractの正本にしない。

## Consequences

### Positive

- adapterの実装言語を限定しない
- Node ABIやnative addonのbuild matrixを持ち込まない
- core crashをharness processから隔離できる。process restartを通常経路としてtestできる
- protocol fixtureを全adapterで共有できる
- LLMがRust内部とDSH内部を同時に読む必要がない

### Negative / Risks

- request単位のprocess起動cost。LLM処理に比べれば無視できるが、高頻度のpollingには向かない
- stdin / stdoutの扱いを誤るとprotocolが壊れる。stdoutへのlog出力を禁止し、testで検査する

### Follow-up

- protocol schemaとexampleは `spec/protocol/v1/`、fixtureは `spec/conformance/`
- error codeの登録簿は [docs/reference/error-codes.md](../reference/error-codes.md)
- 互換性判定は [docs/reference/compatibility.md](../reference/compatibility.md)

## Alternatives considered

- **N-API binding** — Node ABIとbuild matrixを持ち込み、core crashがharness processを巻き込む。adapter言語をNodeに固定する。
- **WASM** — filesystemとlockを要するjournalをWASM境界の外に出す必要があり、初期には複雑さが見合わない。
- **persistent process（`aizu serve`）を最初から** — lifecycle、再接続、多重化の設計が先に必要。one-shotで契約を固めてから追加する。
