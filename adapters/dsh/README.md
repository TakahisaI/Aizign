# @aizign/adapter-dsh

The DSH harness adapter: a cordis plugin that registers one **scope-bound** `submit_workflow_signal` tool backed by the `aizign` binary over Protocol v1.

| | |
|---|---|
| **Responsibility** | DSH plugin entry（`name` / `inject` / `Config` / `apply`）、model-visible tool用preflight（canonical framed `handle` hello → exact correlation → protocol version + submit capability）、`OneShotCoreClient`、agentの引数 → `workflow.signal.submit` payload のmapping、control-plane向けread-only reconciliation clientとその独立したcapability requirement、coreの結果 → tool result / `HarnessError` |
| **Non-responsibility** | 判断（core）、journal（coreのJSONL。DSH persistenceには書かない）、identityの決定（configで固定。agentはinputとして指定・変更できない。成功resultでは固定済み`eventId`を知る）、live smokeの手順（operatorの `op/`） |
| **Inputs** | plugin config（binary、stateDir、timeoutMs、eventId + workflow / assignment / attempt / candidate digest + closed `trustedSignalValues`）、agentのtool call `{ kind, findingCount? }` |
| **Outputs** | model tool result `{ disposition: accepted \| duplicate, eventId }`、control-plane reconciliation outcome、または `HarnessError`（protocol / workflow code、`AIZIGN_OUTCOME_UNKNOWN`、`AIZIGN_UNAVAILABLE`、`AIZIGN_INCOMPATIBLE`） |
| **Hard invariants** | control-plane identityをmodelに選択させない、reconciliationをmodel-visible toolにしない、DSH native IDをenvelopeへ入れない、全operationをshellなしのexact `handle --state stateDir`で起動、helloも`requestId` / `kind`を照合、signal successは`eventId`も照合、stdoutはbyte列のままbody上限・exact LF・stdout/process close・zero exitを確認しCRLFと全post-LF byteを拒否、lifecycle faultは`unknown`で再送しない、preflight失敗時はtoolを登録しない、環境変数を子processへ丸ごと渡さない（PATHのみ） |
| **Allowed dependencies** | `@aizign/protocol`。peer: `@deepseek-ai/cordis` 4.0.1、`dsh-llm` / `dsh-tools` 0.1.1-rc.2、`schemastery` 3.18.1（exact、ADR-0010）。dev: `@aizign/adapter-testkit` |
| **Test command** | `npm test -w @aizign/adapter-dsh`（`AIZIGN_BINARY` を与えると実binaryにも） |
| **Related ADR** | [0003](../../docs/adr/0003-use-a-versioned-ndjson-process-boundary.md)、[0010](../../docs/adr/0010-harness-sdk-dependencies-and-node-policy.md)、[0013](../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md)、[0020](../../docs/adr/0020-narrow-typescript-exports-and-own-dsh-transport.md)、[0022](../../docs/adr/0022-define-the-canonical-one-shot-process-profile.md)、[0024](../../docs/adr/0024-require-isolated-adapter-child-environments.md)、[0025](../../docs/adr/0025-move-dsh-signal-values-behind-trusted-configuration.md)、[0026](../../docs/adr/0026-pin-the-dsh-startup-error-wrapper-boundary.md)、[0027](../../docs/adr/0027-remove-the-dsh-harness-evidence-read-surface.md) |

## Security boundary

Production plugin configuration is a trusted control-plane input after local
shape validation. The internal client factory does not inherit the harness
environment: the child receives `PATH` only. The production
`OneShotCoreClient`, available to repository control-plane consumers only from
the provisional `./experimental/transport` subpath, has no arbitrary child
environment configuration. If the parent has no PATH the child receives an
empty mapping. Repository tests and benchmarks place controls inside generated
non-production executable wrappers. Closed tool arguments prevent the model from choosing
stable identity, but neither the core nor schema can prove honest provenance
from a malicious adapter. The ordinary model cannot supply `artifactRef` or
`shortErrorCode`; the adapter validates and injects those values from closed
trusted configuration before preflight or tool registration. Their text is
not scanned for credentials, prompts, or encoded content, so trusted producers
remain responsible for semantic exclusion. Protocol diagnostic messages
are control-plane data and may contain state-path or operating-system detail;
the tool mapping retains the stable code but replaces argument decoding, local
Protocol validation, rejected, and unknown detail with fixed model-safe
messages. It deliberately
does not attach the original local `ProtocolError` as a cause because DSH's
diagnostic renderer follows cause chains. No supported v0.1 DSH path reads or
relies on harness persistence. See the
[v0.1 threat model](../../docs/security/threat-model.md).

Harness-local argument and binding checks remain adapter-owned. Protocol
source validation is performed exactly once by `encodeRequest` inside
`OneShotCoreClient`, before parent timing, process spawn, stdin acquisition, or
write; the mapper has no encode-then-decode Protocol prevalidation path.

## Layout

```text
src/
├── index.ts                       stable plugin entry: name / inject / Config / PluginConfig / apply
├── config.ts                      Config（schemastery）、descriptor-first trusted-value validation、SignalBinding
├── core-client/one-shot-client.ts OneShotCoreClient（submit / reconcile、spawn → 1 frame → 1 frame、相関照合、frame bound、abort、unknownの分類）
├── timing.ts                      DSH-owned parent timing、fixed-code disclosure、sink isolation
├── experimental/
│   └── transport.ts              closed provisional production-client / preflight / timing exports
├── mapping/
│   ├── tool.ts                    createSubmitWorkflowSignalTool、closed `{kind,findingCount?}` decode、result mapping
│   └── trusted-values.ts          sole trusted-value injection + mapping-key resolver
└── lifecycle/preflight.ts         hello → checkCompatibility
test/
├── helpers/fake-dsh.ts            FakeDsh（tool registry + DSH風dispatch）、fakeBinary
├── unit/                          config、tool mapping（identity非露出、unknown非再送）、plugin apply
└── conformance/
    ├── core-client.test.ts        runCoreClientConformance + 実binary
    └── round-trip.test.ts         fake DSH → plugin → fake core / 実binary → journal、crash時の unknown
cordis.patch.yml                   bundle時にdisabledで挿入。operatorのpatchが有効化する
```

## 設定

このpackageは `dsh.bundle.patch` を宣言しているので、`dsh plugin --profile <name> add …` で入れるとDSHのbundle層に加わり、
[`cordis.patch.yml`](cordis.patch.yml) が entry `aizign-workflow-signal` を **`disabled: true` で挿入**します。
operatorのpatchはその entry を **id で上書き**して有効化します（同じidを `insert` で再挿入すると loader が `duplicate loader entry id` で起動しません）。

```yaml
# operator patch (op/ 側。repositoryには置かない)。--patch で渡すか、profileの cordis.patch.yml に置く
- id: aizign-workflow-signal
  name: "@aizign/adapter-dsh"   # bundle層の entry と一致しないと patch は skip される
  disabled: false
  config:
    binary: /path/to/aizign
    stateDir: /path/to/runtime/aizign-state   # submit writerはfresh storeをdurable初期化。reconcileはmissingを作らずunknown
    timeoutMs: 15000
    eventId: evt-0001
    workflowId: wf-example
    assignmentId: as-implementation
    attemptId: attempt-implementation-01
    role: implementation
    artifactRevision: rev-c0ffee
    candidateDigest:
      algorithm: sha256
      hex: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    trustedSignalValues:
      artifactRef: artifact:implementation-01   # implementationでは必須、reviewでは省略可
      blockedShortErrorCode: BLOCKED_BY_CONTROL_PLANE
```

`trustedSignalValues` はplain own-data recordだけを受け付けます。alias、default、
`null`、明示的`undefined`、accessor、symbol、custom prototype、unknown memberは
`INVALID_EXPECTATION`で起動前に拒否されます。`blockedShortErrorCode`は両roleで
必須、`artifactRef`はimplementationで必須・reviewで任意です。拒否messageは
固定され、raw valueやcauseを保持しません。

`dsh --profile <name> --patch <file> --dump-config` で、合成後の tree に `aizign-workflow-signal` が `disabled: false` と上記 `config` で現れることを確認できます。
[`experiments/dsh-live-smoke/make-patch.mjs`](../../experiments/dsh-live-smoke/make-patch.mjs) はこの形を生成します。

## v0.1 source-checkout installation

The supported v0.1 form for using this adapter is a reviewed or released SHA
Aizign source checkout. Run `npm ci` and `npm run build`, then register
`adapters/dsh` in the DSH profile as a workspace `link:`. `@aizign/protocol` is
also resolved through the npm workspace link inside the checkout. An adapter
standalone `.tgz`, an `@aizign/*` registry install, publication, or bundling is
not a supported distribution form.

A new profile is a pnpm workspace root on the DSH side, so registration must
target that profile root explicitly. The DSH-host registration fixture below
temporarily bootstraps the DSH release's `pnpm@11.7.0` and uses only a new
`DSH_HOME`.

```sh
DSH_HOME="${RUNNER_TEMP}/aizign-dsh-home" \
npx --yes \
  --package=pnpm@11.7.0 \
  --package=@deepseek-ai/dsh@0.1.1-rc.2 \
  -- \
  dsh plugin --profile aizign-ci add -w --allow-build=koffi \
  @deepseek-ai/dsh-web-app@0.1.1-rc.2 \
  "link:${GITHUB_WORKSPACE}/adapters/dsh"
```

Because of `pnpm@11.7.0`'s strict build policy, explicitly allow only the
native `koffi` build required by the DSH web app. No lifecycle script from any
other dependency is run.

This pnpm use is limited to the DSH-host registration fixture and does not
change Aizign's normal package manager (`npm@12.0.2`) or supported tooling.
Inspect the profile bundle, absolute workspace link, package import, and
composed patch entry. Live smoke requiring a browser, login, model, or
credential remains operator evidence under
[Issue #11](https://github.com/TakahisaI/Aizign/issues/11). Discard the
temporary `DSH_HOME` after verification.

## Capability classification

This adapter satisfies the current minimum signal-submission behavior through
protocol preflight, trusted config-bound identity and opaque-value injection, full response
correlation, exact outcome propagation, non-collapse of `unknown`,
the closed metadata field set with producer obligations for trusted opaque values,
model-facing diagnostic normalization, and bounded process I/O. This does not
claim semantic inspection or authenticity of configured `artifactRef` or
`blockedShortErrorCode`.

No current v0.1 DSH supported path claims harness-persisted evidence, session
cold read, retention, durability, cancellation, or source-side resource
bounds. The fake DSH proves registration and dispatch behavior only.

`workflow.signal.reconcile` is a separate core protocol capability and performs
a bounded read-only lookup of the authoritative Aizign journal. Submit and
reconciliation preflight remain independent.

Interrupt, effect dispatch, resource release, ownership, general lifecycle, and
remote reconnect are provisional inventory, not implemented DSH capabilities or
stable tokens.

The package root is only the Cordis plugin entry. Repository control-plane and
benchmark code may import the exact provisional `./experimental/transport`
subpath. Mapping, config-validation, tool
constants/codes, and capability arrays remain internal. Runtime and declaration
allowlists are verified by `spec/test/package-exports.test.mjs`; deep `src/` or
generated `lib/` imports are unsupported.

`apply()` が登録するのはsubmit toolだけなので、そのpreflightが要求するcapabilityも `workflow.signal.submit` だけです。experimental transportの `OneShotCoreClient.reconcileWorkflowSignal()` をcontrol planeから直接使う場合は、`hello()` とProtocol `checkCompatibility()`で `workflow.signal.reconcile` を独立に確認します。内部のcapability requirement配列はexportしません。reconciliation capabilityがないことを理由にsubmit toolまで非公開にはしません。

## Opt-in timing

`OneShotCoreClient`はDSH-owned `OneShotCoreClientConfig.timingSink`、`preflight`は`PreflightOptions.timingSink`がある場合だけmetadata-only timingを通知します。
preflightは全体の`preflight_ms`を記録します。
どのmeasurementにもsession ID、signal identity、path、本文を含めません。
`error_code`は固定された認識済みcodeのallowlistに限り、正形式でも未認識のpeer
codeは返却outcomeのcontrol-plane診断にだけ保持してtimingから除外します。
successful correlated helloで判明したversion / required submit capability
不一致は`preflight` / `rejected`として記録し、peerが返していないProtocol
`error_code`や`unknown_reason`は追加しません。DSH boundaryは
`AIZIGN_INCOMPATIBLE`を返します。
同期throwと非同期Promise rejectionを共通helperで隔離するため、sink failureはtool登録、submit、reconcileを変えません。

## Harness-facing codes

| Code | 意味 |
|---|---|
| `AIZIGN_UNAVAILABLE` | preflightでbinaryに到達できない、または `hello` がerror |
| `AIZIGN_INCOMPATIBLE` | protocol versionが違う、またはcapabilityがない |
| `AIZIGN_OUTCOME_UNKNOWN` | 提出の結果が不明（無応答、garbage、2 frame、oversized、相関不一致、timeout、abort、`JOURNAL_OUTCOME_UNKNOWN`、`HANDLER_TIMEOUT`、`INTERNAL`、正形式だが未認識のpeer code）。peer codeはcontrol-plane診断にのみ保持し、この固定adapter codeへ正規化してmodelへ返す。再送しない |
| `INVALID_SIGNAL` ほか | operation-specific allowlist上の確定的なprotocol / workflow / journal rejection codeだけを保持 |
| `INVALID_EXPECTATION` | plugin configの検証に失敗 |

Malformed `trustedSignalValues` produces the fixed inner error
`HarnessError("Aizign rejected invalid trusted signal configuration",
"INVALID_EXPECTATION")` without a cause. Under the supported pinned DSH
startup path it is then wrapped by `@deepseek-ai/cordis-plugin-loader` for the
adapter entry, by the loader for the include entry, and finally by
`@deepseek-ai/dsh-app-boot`; these outer plain `Error` wrappers are host-owned
diagnostic context and do not change the adapter code or add rejected values.
See [ADR-0026](../../docs/adr/0026-pin-the-dsh-startup-error-wrapper-boundary.md).
