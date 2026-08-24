# ADR-0013: Add bounded read-only workflow signal reconciliation

- Status: Accepted
- Date: 2026-08-24
- Related: ADR-0003, ADR-0004, ADR-0007, ADR-0012, Issue #51

## Context

`workflow.signal.submit` can durably append a signal and still leave its caller with an unknown outcome. A timeout, lost response, correlation mismatch, malformed response, or `JOURNAL_OUTCOME_UNKNOWN` does not prove either acceptance or rejection. Hard invariants 3 and 4 therefore prohibit a blind retry and prohibit guessing the outcome.

The Aizign journal is the authority for workflow-signal acceptance. Harness-native persistence can provide useful adapter-local evidence, but it is neither required nor authoritative for the core. A restarted control plane needs a bounded, read-only operation that compares the exact signal it attempted to submit with a consistent journal snapshot.

This operation crosses the protocol boundary and introduces a recovery contract. Its request shape, outcomes, concurrency semantics, and failure classification must be fixed before implementation.

## Decision

Add a pure `recovery` context to `aizign-core`. Given a completely replayed `WorkflowState` and a validated `WorkflowSignal`, it classifies the signal as:

- `accepted`: the same `eventId` and exactly the same signal content are present;
- `conflict`: the same `eventId` is present with different signal content;
- `absent`: no event with that `eventId` is present.

The pure core does not produce `unknown`. `unknown` means the shell could not obtain and replay a complete, trustworthy snapshot.

Add the Protocol v1 request kind and capability `workflow.signal.reconcile`. This is an additive kind under ADR-0003, so it does not change the envelope or an existing payload and does not require a protocol-version bump. The journal record shape is unchanged, so the journal schema version also remains 1.

The request payload carries the full structured signal that may have been submitted:

```json
{
  "signal": {
    "eventId": "evt-0001",
    "workflowId": "wf-example-01",
    "assignmentId": "as-implementation-01",
    "attemptId": "attempt-01",
    "role": "implementation",
    "artifactRevision": "rev-c0ffee",
    "candidateDigest": {
      "algorithm": "sha256",
      "hex": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "kind": "implementation_ready"
  }
}
```

The signal uses exactly the same closed DTO and validation rules as `workflow.signal.submit`. The request does not carry `expected`: reconciliation asks what the journal durably contains, not whether a new submission matches a current assignment. Exact content comparison includes workflow, assignment, attempt, role, revision identifier, candidate digest, signal kind, and every present optional structured field. It does not introduce a signal-content digest or a new digest authority.

A completed lookup returns an `ok: true` payload:

```json
{
  "disposition": "accepted",
  "eventId": "evt-0001"
}
```

`disposition` is one of `accepted`, `conflict`, or `absent`. Every successful response echoes the queried `eventId` so clients can correlate request ID, kind, and event identity. `absent` is only an observation of the completed snapshot. It does not authorize this operation or an adapter to retry submission automatically.

Represent an indeterminate lookup as the normal protocol error envelope, preserving the specific stable code that prevented a trustworthy result. Journal open, lock, schema, corruption, and bound failures retain their existing `JOURNAL_*` codes; the outer processing watchdog retains `HANDLER_TIMEOUT`. The TypeScript client maps every reconciliation error response, transport failure, malformed or oversized response, timeout, abort, and correlation mismatch to its semantic `unknown` outcome. It never maps one of those failures to `absent`.

The reconciliation client's unknown result has a structured slot for a syntactically valid code reported by a response:

```ts
type ReconcileUnknown = {
  readonly kind: 'unknown';
  readonly reason: UnknownReason;
  readonly reportedCode?: string;
  readonly detail: string;
};
```

Response handling follows this order:

1. Decode exactly one bounded response envelope.
2. If the decoded body is an error, retain its syntactically valid code as `reportedCode`.
3. Check `requestId`, `kind`, and, for a successful reconciliation body, `eventId` correlation.
4. If correlation fails, return semantic `unknown` with reason `correlation_mismatch`. A retained `reportedCode` is only a diagnostic observed on an uncorrelated response; it is not evidence that the code describes the caller's request.
5. If correlation succeeds, map a reconciliation success body to its known disposition and any error body to semantic `unknown` with reason `reported_unknown`.

This order deliberately preserves `HANDLER_TIMEOUT` from the current watchdog response, whose `requestId` and `kind` are `null`, while still treating that response as uncorrelated and therefore unknown.

Split the engine journal port into read and write capabilities. A `JournalReader` exposes only `load_committed`, which returns a bounded cold snapshot only after the store's durability barrier succeeds. The existing `Journal` extends it with durable append. The reconciliation use case accepts only `JournalReader`, replays into a fresh in-memory state, performs the pure classification, and has no clock, append, submit, or effect dependency. Every JSONL load path, including the append-capable journal's pre-decision load, uses the same committed-snapshot contract; no caller may classify merely readable but uncommitted bytes as accepted.

Add a logically read-only JSONL journal reader that never creates a state directory, lock file, or journal file and never appends, truncates, rewrites, or otherwise changes journal content. A trustworthy snapshot requires an existing private state directory, ownership lock file, and journal file. If any of those three is missing, the reader returns `JOURNAL_UNAVAILABLE`, which the client exposes as `unknown`. Missing storage cannot prove that the authoritative journal has always been empty: the path may be uninitialized, misconfigured, unmounted, deleted, lost, or refer to another state location.

For existing storage, `load_committed` performs the following sequence:

1. Acquire the shared advisory lock without waiting. Writers continue to take the exclusive lock.
2. Open the existing journal without create, append, or truncate capability. The implementation may require a read-write file descriptor solely to invoke the platform's `sync_data` operation; it must not change the file's logical bytes or length.
3. Read the bounded snapshot and completely decode every record. A truncated, corrupt, or out-of-bounds snapshot is `unknown` and is not deliberately committed by the reader.
4. While still holding the shared lock, execute the same `sync_data` durability barrier used by append.
5. Return the decoded entries only if that barrier succeeds. If it fails, return `JOURNAL_OUTCOME_UNKNOWN`, which remains semantic `unknown`.

The successful barrier is what promotes a completely decoded, currently readable snapshot to a committed snapshot. This distinction covers an append whose `write_all` completed but whose original `sync_data` failed: a later reconciliation may return `accepted` only after its own barrier succeeds. If that later barrier also fails, the outcome remains `unknown`; a read alone never proves durability.

`absent` is returned only from a committed snapshot. An existing zero-record journal whose reconciliation barrier succeeds is authoritative evidence of an initialized empty state; a missing journal is not. A submission failure that occurs after the writer initialized an empty journal can therefore reconcile as `absent`, while a failure before journal initialization remains `unknown`.

The reader holds the shared lock through the bounded decode and durability barrier. A concurrent writer therefore either completes before the reader snapshot, starts after it, or causes the non-blocking lock attempt to return `JOURNAL_LOCKED`; the reader never interprets or commits a partial concurrent append. The outer one-shot handler watchdog bounds total request processing time in addition to the existing frame-size, journal-byte, and record-count bounds.

Add `reconcileWorkflowSignal` to the TypeScript `CoreClient`. It is a control-plane/operator method, not a model-visible tool. The DSH adapter implements and exports the client method but does not add tool arguments, a second tool, automatic reconciliation, or automatic retry. Harness session IDs, call IDs, provider IDs, prompts, model output, reasoning, and credentials remain outside the reconciliation envelope.

## Consequences

### Positive

- A lost acknowledgement can be resolved after restart from the authoritative journal without resubmitting the signal.
- A successful committed-snapshot barrier distinguishes durable journal evidence from bytes that are only currently readable after an uncertain append.
- Exact event-content comparison preserves attempt and candidate binding and distinguishes acceptance from an event conflict.
- The read-only type boundary makes append and effect dispatch unavailable to the reconciliation use case.
- Shared-lock reading gives the outcome a precise snapshot meaning under concurrent access.
- Existing stable journal codes explain `unknown` without adding a generic code that discards the cause.
- Protocol v1 remains extensible through capabilities and the journal format remains unchanged.

### Negative / Risks

- The caller must retain or reconstruct the exact structured signal it attempted to submit.
- A legitimate but never-initialized state directory cannot produce `absent`; a writer must first establish the authoritative lock and journal files.
- Without a durable state-instance identity, a misconfigured path that points to another fully initialized, valid journal cannot be detected. Selecting the configured state directory remains a control-plane responsibility until a manifest contract is added.
- An active writer makes a non-blocking reconciliation attempt `unknown` (`JOURNAL_LOCKED`) rather than waiting.
- A logically read-only reconciliation still performs durability I/O and may require write permission on the existing journal solely to execute `sync_data`. A read-only mount or barrier failure therefore produces `unknown`.
- A full bounded cold read is linear in journal size and is not suitable for high-frequency polling.
- `absent` can become stale immediately after the shared lock is released; it is not permission to retry.
- Adding a committed-snapshot store path duplicates a small amount of open and permission-checking logic while preserving the no-logical-mutation boundary.

### Follow-up

- Add language-neutral request and response fixtures for `accepted`, `conflict`, `absent`, and an error-envelope `unknown` case.
- Test a lost acknowledgement followed by reconciliation in a fresh process, an initialized pre-append failure followed by `absent`, and a changed signal followed by `conflict`.
- Fault-inject `write_all` success followed by `sync_data` failure with a complete newline-terminated record still readable, then reopen: reconciliation may report `accepted` only after its own durability barrier succeeds, and must remain `unknown` if that barrier fails.
- Fix the initialization matrix: missing directory, directory without a lock, lock without a journal, and a different uninitialized state location are `unknown`; a shared-locked zero-record journal is `absent`; a first writer racing any intermediate state is `unknown` until a complete snapshot can be acquired.
- Test corruption, bound, lock, timeout, malformed response, oversized response, abort, and correlation mismatch as `unknown`.
- Add a response fixture and client test for `requestId: null`, `kind: null`, and `error.code: HANDLER_TIMEOUT`; assert `reason: correlation_mismatch` and diagnostic `reportedCode: HANDLER_TIMEOUT`.
- Prove the operation does not append records, dispatch effects, retry submission, or leak harness/provider data.
- Keep automatic retry policy, external-effect reconciliation, general restart supervision, and harness-native evidence lookup in separate decisions.

## Alternatives considered

- **Resubmit the original command and use duplicate detection.** Rejected because an absent signal would be appended, turning a read into a write and making reconciliation an implicit retry.
- **Carry `expected` as well as `signal`.** Rejected because current assignment expectation is irrelevant to the historical journal fact and can introduce an unrelated mismatch.
- **Carry only a new digest of the signal.** Deferred because it requires a canonical signal encoding and a new digest authority. The existing structured signal is already bounded and closed.
- **Return `unknown` as an `ok: true` disposition.** Rejected because the specific stable failure code is useful and the existing error envelope already carries it. Clients still expose the semantic outcome as `unknown`.
- **Read without a lock or retry until the lock becomes available.** Rejected because an unlocked read can observe a partial append, while waiting or retrying introduces an additional scheduling policy. A non-blocking lock failure remains `unknown`.
- **Treat missing state files as an empty snapshot or create them while reconciling.** Rejected because missing storage is not authoritative evidence of emptiness, and a read-only recovery operation must not mutate the filesystem merely to report `absent`.
- **Exclude only requests already known to have returned `JOURNAL_OUTCOME_UNKNOWN`.** Rejected because an outer timeout, response loss, or correlation failure can conceal the same underlying `sync_data` failure. The original caller-visible cause is not a sufficient durability proof.
- **Treat any completely decoded snapshot as committed without a durability barrier.** Rejected because `write_all` can make a complete record readable before `sync_data` fails. Readability alone does not satisfy the durable-acceptance contract.
- **Weaken `accepted` to mean only present in the current snapshot.** Rejected because Issue #51 and ADR-0007 require durable acceptance; weakening the term would leave an uncertain append unresolved while presenting it as known.
- **Add a durable state-instance manifest in this slice.** Deferred. A manifest could distinguish initialized storage and, with a control-plane identity, detect a wrong state instance. It would add a new durable identity and initialization contract beyond workflow-signal reconciliation; until that contract exists, missing state artifacts remain `unknown` and the configured state directory remains a control-plane responsibility.
- **Increase the protocol or journal version.** Rejected because this adds a new capability and request kind without changing existing message or record shapes.
