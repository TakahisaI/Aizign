# Hard invariants

この文書は、repository全体で守るhard invariantsの正本です。
理由と設計判断の履歴は [ADR](../adr/) にあり、実際の挙動はsource、test、`spec/conformance/`が示します。

内容を変更する場合は、関連する設計判断を新しいADRでsupersedeし、この文書と実装・testを同じPRで更新します。
`AGENTS.md`、package README、Issue、PRへ別の正本を作りません。
各invariantの現在のenforcement owner、test evidence、未実装範囲は
[`docs/security/threat-model.md`](../security/threat-model.md) に対応付けます。

1. 自然言語、idle、画面表示を完了の正本にしない。
2. External effectはeffect前にdurable claimする。
3. Effect結果が不明ならblind retryしない。
4. `unknown` を成功または失敗へ推測しない。
5. Evidenceをworkflow、assignment、attempt、candidate revisionへbindingする。
6. Review passだけでintegrationしない。
7. Human authorizationはrevision-boundかつappend-onlyにする。
8. Provider固有identityをcore identityにしない。
9. Restart reconciliationはboundedかつread-onlyにする。
10. Control journalはmetadata-onlyのclosed field setとし、producerはraw prompt、model output、reasoning、credentialをallowed opaque valueにも入れない。
11. Remote publication、repository visibility変更、force updateを自動実行しない。
12. 同一identity・同一内容はduplicate、同一identity・異内容はconflictにする。

## Current and future applicability

These invariants are durable principles, but an invariant does not imply that
every domain named by it is implemented.

- Invariant 2 applies when a future external-effect operation exists. The
  current runtime has no external-effect intent, claim, dispatch, result, or
  effect-reconciliation operation, record, capability, or public API.
- The no-blind-retry principle in invariants 3 and 4 applies today to signal
  submission when the accepted-event append or acknowledgement outcome is
  unknown. `unknown` is preserved and does not authorize resubmission. It must
  also apply to future effects if and when the promotion trigger in the
  [architecture overview](overview.md#futureprovisional-inventory) is met.
- Invariant 9 applies today to `workflow.signal.reconcile`, which is bounded
  and read-only. It does not imply a future effect-reconciliation design.

ADR-0029 accepts, but the current runtime does not yet implement, a DSH-owned
logical-submission fence for invariants 3 and 9. The target publishes the exact
attempt before child spawn, keeps unknown outcomes reconciliation-required
across restart, and never treats reconciliation `absent` as permission to
submit again. Its sole authority is
[`spec/dsh/lifecycle/v1/`](../../spec/dsh/lifecycle/v1/README.md); conformance
begins only when the ordered S2 migration lands.
