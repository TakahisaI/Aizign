# Initial runtime performance budgets and PR smoke policy

Status: provisional gross-regression budgets, introduced as informational in Issue #58.

These budgets preserve the measurement and semantic boundaries established by Issue #57. They are deliberately unsuitable for detecting small percentage regressions on GitHub-hosted runners. Their purpose is to expose hangs, multi-second regressions, invalid journal-boundary behavior, and unexpected lock or reconciliation outcomes without weakening durability or unknown-outcome semantics.

The ceilings apply only to the Linux GitHub-hosted smoke environment. No macOS or Windows budget is inferred: those storage targets do not currently advertise the measured workflow operations, and their filesystem behavior has not been baselined.

## Native reference observations

All reference runs measured commit `ee93496eb0a7a08666770b0bffcc2aa33b23e79a` with runner v3, release profile, Ubuntu 24.04 image `20260816.277.1`, 3 unrecorded warmups, 20 recorded warm samples per point, and nearest-rank percentiles. The raw `result.json` and human `summary.md` remain in the workflow artifacts. Their source metadata, SHA-256 digests, and recomputed highest p95 values are preserved in the [native baseline manifest](../../benchmarks/performance/native-baseline-v3.json), so expiring workflow artifacts are not the only durable budget evidence.

| Run | CPU | Result |
|---|---|---|
| [32792032577](https://github.com/TakahisaI/Aizign/actions/runs/32792032577) | AMD EPYC 9V74 | success |
| [32792661803](https://github.com/TakahisaI/Aizign/actions/runs/32792661803) | Intel Xeon Platinum 8573C | success |
| [32792663958](https://github.com/TakahisaI/Aizign/actions/runs/32792663958) | Intel Xeon 6973P-C | success |

The third run demonstrates why a fine-grained hosted-runner gate would be misleading. For example, `transport/accepted_0` handler p95 ranged from 1.372 ms to 400.322 ms, and `assignment_submit` end-to-end p95 ranged from 8.699 ms to 828.076 ms. The semantic outcomes remained correct. These large transient stalls occurred inside measured work, including `append_sync_ms`, and are not evidence for relaxing `sync_data()` or returning before durable publication.

## Measurement boundaries

- `handler_total_ms` is child-internal work through response flush; process spawn is excluded.
- `spawn_to_exit_ms` is the parent observation from spawn through the child exit event.
- `aizign_end_to_end_ms` covers the fixed operation count for one named assignment scenario.
- `journal_entries_before_operation` includes a seeded duplicate target. Accepted submit never starts at 10,000 entries, and duplicate never starts at zero.
- `journal_entries_before_batch` is used for concurrency because successful same-state contenders may append before later lock acquisition.
- `new_process_new_open` and `warm_repeated` describe process/store lifecycle only. No hosted run claims a true cold OS page cache.

The runner records the active timeout settings with each artifact: 10,000 ms core watchdog, 15,000 ms DSH adapter timeout, and 60,000 ms per-operation benchmark guard. This issue does not negotiate or change runtime timeout contracts.

## Canonical scenarios

The scenario names and operation counts are fixed:

```text
assignment_submit:
  preflight 1 + signal submit 1

assignment_unknown_reconcile:
  preflight 1 + lost-ACK signal submit 1 + explicit read-only lookup 1
```

The lost-ACK path performs the durable submit once, suppresses its response, preserves `unknown/no_response`, and performs exactly one read-only lookup. Scenario totals are not mixed with hello, preflight, submit, or lookup operation distributions.

## Provisional budgets

The PR smoke compares the maximum of three recorded warm samples with the following absolute ceilings. The native reference column is the highest p95 observed across the three reference runs, not a threshold derived from one favored machine.

| Boundary | Highest native p95 | Informational PR ceiling | Statistic |
|---|---:|---:|---|
| direct child handler, every accepted / duplicate / bound-exceeded / lookup point | 400.322 ms | 3,000 ms | max of 3 |
| direct parent spawn-to-exit, same points | 401.957 ms | 5,000 ms | max of 3 |
| hello spawn-to-exit, both scenarios | 3.356 ms | 1,000 ms | max of 3 |
| preflight, both scenarios | 3.469 ms | 1,000 ms | max of 3 |
| `assignment_submit` total | 828.076 ms | 5,000 ms | max of 3 |
| `assignment_unknown_reconcile` total | 320.318 ms | 7,000 ms | max of 3 |
| normal scenario submit spawn-to-exit | 824.695 ms | 5,000 ms | max of 3 |
| lost-ACK submit spawn-to-exit | 315.271 ms | 5,000 ms | max of 3 |
| reconciliation lookup spawn-to-exit | 4.521 ms | 3,000 ms | max of 3 |
| concurrency 1 / 2 batch total | 449.382 ms | 5,000 ms | max of 3 |

Hello and whole-preflight remain separate observations; preflight includes exactly one hello and is the public control-plane boundary.

The ceilings are intentionally many times the noisiest observed p95 and remain below the relevant 10-second core watchdog where applicable. Exceeding one is a prompt to inspect stage attribution and repeat the full baseline in a stable environment; it is not permission to weaken durability, lock, timeout, or unknown-outcome behavior.

## Journal scale and stage attribution

Across the three runs, the stable 10,000-entry read path remained dominated by committed-prefix decode and replay:

| Case | Load/decode p95 max | Replay p95 max | Handler p95 max |
|---|---:|---:|---:|
| accepted, 0 entries | 0.056 ms | 0.0001 ms | 341.681 ms |
| accepted, 1,000 entries | 4.756 ms | 1.148 ms | 155.118 ms |
| accepted, 9,999 entries | 47.141 ms | 12.188 ms | 409.304 ms |
| duplicate, 10,000 entries | 46.890 ms | 12.133 ms | 135.135 ms |
| absent lookup, 10,000 entries | 43.127 ms | 12.056 ms | 58.811 ms |

Load/decode grew by roughly 4–5 microseconds per additional entry over the large bands, while replay added roughly 1.2 microseconds per entry. Hosted-runner stalls sometimes appeared in append/sync instead, so the smoke reports committed-prefix, replay, append/sync, handler, and parent values together when a ceiling fails. The full scheduled baseline remains the source for trend and slope decisions.

## Full baseline versus PR smoke

The manual/scheduled baseline retains all semantic outcomes, Rust-direct and TypeScript transports, concurrency 1 / 2 / 4 / 8, maximum-payload cases, cold-boundary observations, and 20-sample p50/p95/p99 aggregates.

The Linux-only PR smoke is intentionally smaller:

- accepted: 0 / 100 / 9,999 entries;
- duplicate: 1 / 100 / 10,000 entries;
- new-event `JOURNAL_BOUND_EXCEEDED`: 10,000 entries;
- absent read-only lookup: 0 / 100 / 10,000 entries;
- same-state and different-state submit concurrency: 1 / 2;
- both canonical assignment scenarios;
- one warmup and three recorded warm samples, with no p99 claim.

Semantic assertions remain strict. Same-state submit allows only accepted or `JOURNAL_LOCKED` and requires at least one acceptance; different-state submit requires every operation to be accepted. `JOURNAL_BOUND_EXCEEDED` and `JOURNAL_LOCKED` remain distinct stable codes. No operation is retried to obtain a passing sample.

The workflow is initially informational because branch protection does not require it. A failed observation remains a red optional check and uploads either the full result or a metadata-only failure manifest; it is never converted to a green job. Promotion to a required gross-regression check requires all of the following:

1. at least three scheduled baseline runs and ten PR smoke runs on the current runner version;
2. no false alerts at the current ceilings;
3. a reviewed branch-protection change that makes the already-failing smoke check required without tightening the ceilings from hosted-runner data alone;
4. documented triage ownership and an explicit return to informational status if runner-image changes create false alerts.

## Optimization triggers

Optimization is a follow-up decision, not part of this change.

- Consider a persistent process only if parent spawn overhead remains the dominant portion of scenario latency and a canonical scenario repeatedly exceeds its budget in stable native runs.
- Consider snapshot, index, or SQLite journal designs only if `journal_load_decode_ms + replay_ms` repeatedly exceeds 1,000 ms p95 in stable runs, normal journals commonly occupy the large bands, lookup becomes a primary latency, or normal operations expose single-owner contention.
- Consider decoder work only if decode remains a principal attributed cost after excluding filesystem and scheduling stalls.
- Consider an incremental committed-prefix hasher only if publish hashing becomes material relative to the full handler. The reference 9,999-entry accepted run had publish hash p99 about 3 ms, so it is not currently an optimization priority.

None of these triggers permits removing durable sync, returning accepted before publication, blind retry after unknown, hiding `JOURNAL_LOCKED` behind an implicit queue, or adding a benchmark-only production fast path.
