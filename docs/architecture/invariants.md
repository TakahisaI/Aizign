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
10. Control journalへraw prompt、model output、reasoning、credentialを保存しない。
11. Remote publication、repository visibility変更、force updateを自動実行しない。
12. 同一identity・同一内容はduplicate、同一identity・異内容はconflictにする。
