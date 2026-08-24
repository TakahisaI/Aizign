# ADR-0013: Add bounded read-only workflow signal reconciliation

- Status: Accepted
- Date: 2026-08-24
- Related: ADR-0003, ADR-0004, ADR-0007, ADR-0012, Issue #51, PR #61

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

Split the engine journal port into read and write capabilities. A `JournalReader` exposes only `load_committed`, which returns a bounded snapshot that the writer previously published as committed. It performs no write, flush, sync, repair, initialization, or commit action. The existing `Journal` extends it with durable append. The reconciliation use case accepts only `JournalReader`, replays into a fresh in-memory state, performs the pure classification, and has no clock, append, submit, recovery-write, or effect dependency.

The current single JSONL file cannot distinguish a successfully synchronized record from a complete record left readable after `sync_data` failed. Add a versioned, owner-only store metadata file, `workflow.commit.json`, that publishes the committed JSONL prefix. Its closed document contains the store-metadata version, committed byte length, committed entry count, and SHA-256 digest of exactly that prefix. The prefix digest is store-internal integrity metadata and never crosses the protocol boundary or becomes core candidate identity. This is store metadata, not a journal record; Protocol v1 and journal schema v1 remain unchanged.

The JSONL writer establishes durable initialization before it may append or report the store initialized:

1. Create the state directory if needed, synchronize it and the parent directory that names it, and fail closed if the required directory barrier is unavailable.
2. Create or open the owner-only lock file, acquire its exclusive lock, create the empty owner-only journal, synchronize both files, and synchronize the state directory that names them.
3. Publish the zero-entry commit metadata using the same atomic replacement procedure used after append, then synchronize the state directory.

An empty journal is authoritative only after that sequence. A writer may complete a failed empty initialization under the exclusive lock, but it must not silently adopt a non-empty journal that has no valid commit metadata. Missing state directory, lock, journal, or commit metadata remains `JOURNAL_UNAVAILABLE`; an unsupported metadata version is `JOURNAL_SCHEMA_UNSUPPORTED`; malformed or inconsistent metadata is `JOURNAL_CORRUPT`.

Append publishes a new committed prefix in this order:

1. Require the physical journal length and digest to match the current committed prefix. Any bytes beyond the published boundary are an unresolved prior append, so the writer returns `JOURNAL_OUTCOME_UNKNOWN` without appending.
2. Append exactly one complete record and run the journal file's `sync_all` barrier, including the file metadata required to recover its new length. This replaces the current `sync_data`-only append contract.
3. Only after that barrier succeeds, write the next commit document to an owner-only temporary file, synchronize that file, atomically replace `workflow.commit.json`, and synchronize the state directory.
4. Return the appended entry only after the metadata and directory barriers succeed. A failure after the first journal byte is written remains `JOURNAL_OUTCOME_UNKNOWN`.

The ordering makes a visible, valid new commit point safe evidence: the referenced JSONL prefix completed its file and file-metadata barrier before the writer could publish that point. If metadata replacement or its directory barrier fails, a reader may observe either commit point. The new point is safe because its referenced prefix was already synchronized; the old point leaves an extra tail and therefore remains `unknown`. A later effectful recovery operation may decide how to handle such a tail, but read-only reconciliation does not promote, truncate, or repair it.

The JSONL `load_committed` path is strictly observational:

1. Require the existing private state directory, lock file, journal file, and commit metadata, then acquire the shared advisory lock without waiting.
2. Open the journal and metadata read-only and read them within their byte and entry bounds.
3. Require the physical file length to equal the committed byte length, the decoded entry count to equal the committed count, and the prefix digest to match. A shorter file or mismatched count/digest is `JOURNAL_CORRUPT`; any extra tail is `JOURNAL_OUTCOME_UNKNOWN`.
4. Return the decoded entries without changing file contents, length, metadata documents, or durability state.

`absent` is returned only from a valid published zero-entry snapshot. A submission failure after durable initialization but before the first append can therefore reconcile as `absent`, while a failure before initialization remains `unknown`. A complete record left after `write_all` succeeded and `sync_data` failed is beyond the published boundary and remains `unknown`, even after restart.

The reader holds the shared lock through metadata validation and bounded decode. A concurrent writer therefore either publishes before the reader snapshot, starts after it, or causes the non-blocking lock attempt to return `JOURNAL_LOCKED`; the reader never interprets a partial concurrent append. The outer one-shot handler watchdog bounds total request processing time in addition to the existing frame-size, journal-byte, metadata-byte, and record-count bounds.

Directory durability is part of the store contract, not an optional optimization. The initial implementation supports only platforms on which it implements and tests equivalent file synchronization, atomic replacement, parent-directory synchronization, and state-directory synchronization. On any other platform it fails closed with `JOURNAL_UNAVAILABLE`; it must not silently downgrade the durability guarantee. The normative first implementation is the Unix barrier sequence above, with Linux covered in CI. Additional platform support requires platform-specific contract tests before it is claimed.

Add `reconcileWorkflowSignal` to the TypeScript `CoreClient`. It is a control-plane/operator method, not a model-visible tool. The DSH adapter implements and exports the client method but does not add tool arguments, a second tool, automatic reconciliation, or automatic retry. Harness session IDs, call IDs, provider IDs, prompts, model output, reasoning, and credentials remain outside the reconciliation envelope.

## Consequences

### Positive

- A lost acknowledgement can be resolved after restart from the authoritative journal without resubmitting the signal.
- A writer-published commit point distinguishes durable journal evidence from bytes that are only currently readable after an uncertain append.
- Exact event-content comparison preserves attempt and candidate binding and distinguishes acceptance from an event conflict.
- The read-only type boundary makes append and effect dispatch unavailable to the reconciliation use case.
- Shared-lock reading gives the outcome a precise snapshot meaning under concurrent access.
- Existing stable journal codes explain `unknown` without adding a generic code that discards the cause.
- Protocol v1 remains extensible through capabilities and the journal record format remains unchanged; only the versioned JSONL store layout gains commit metadata.

### Negative / Risks

- The caller must retain or reconstruct the exact structured signal it attempted to submit.
- A legitimate but never-initialized state directory cannot produce `absent`; a writer must first establish the authoritative lock and journal files.
- Without a durable state-instance identity, a misconfigured path that points to another fully initialized, valid journal cannot be detected. Selecting the configured state directory remains a control-plane responsibility until a manifest contract is added.
- An active writer makes a non-blocking reconciliation attempt `unknown` (`JOURNAL_LOCKED`) rather than waiting.
- A failed append can leave an unpublished tail that blocks both reconciliation and further append until a separate effectful recovery policy resolves it. This is a conservative `unknown`, not silent truncation or promotion.
- Durable initialization and atomic commit metadata add filesystem barriers, a bounded sidecar format, a prefix digest, and write amplification to the JSONL store.
- Existing non-empty state directories without valid commit metadata cannot be adopted automatically; migration or explicit recovery is separate work.
- Platforms without tested file and directory durability primitives fail closed instead of receiving a weaker `accepted` contract.
- A full bounded cold read is linear in journal size and is not suitable for high-frequency polling.
- `absent` can become stale immediately after the shared lock is released; it is not permission to retry.

### Follow-up

- Add language-neutral request and response fixtures for `accepted`, `conflict`, `absent`, and an error-envelope `unknown` case.
- Test a lost acknowledgement followed by reconciliation in a fresh process, an initialized pre-append failure followed by `absent`, and a changed signal followed by `conflict`.
- Fault-inject `write_all` success followed by the journal `sync_all` failure with a complete newline-terminated record still readable. Assert that the commit point remains unchanged, reopen returns `unknown`, no reader-side barrier occurs, and a later unrelated submit does not append or promote the tail. This test covers the same uncertainty as the current store's `sync_data` failure path.
- Fault-inject response loss after the journal, commit metadata, and directory barriers succeed; a fresh-process read-only reconciliation must return `accepted` without changing any state artifact.
- Test initialization crashes after state-directory creation, lock-file creation, journal-file creation, journal-file synchronization but before state-directory synchronization, initial commit publication, and final directory synchronization. Only a valid published zero-entry commit point may yield `absent`.
- Fix the initialization matrix: missing directory, directory without a lock, lock without a journal, journal without valid commit metadata, and a different uninitialized state location are `unknown`; a shared-locked zero-record journal with a valid zero-entry commit point is `absent`; a first writer racing any intermediate state is `unknown` until a complete snapshot can be acquired.
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
- **Run `sync_data` from `load_committed`.** Rejected because synchronization changes durability state: the reconciliation call could commit an uncertain prior append or an unrelated later submit could do so while merely loading. That violates hard invariant 9 and the Issue #51 no-state-change condition.
- **Move synchronization into an explicit `recover` or `commit` operation.** Compatible with this decision as future work, but intentionally separate because it is effectful and requires an authorization and tail-resolution policy. `workflow.signal.reconcile` remains read-only.
- **Treat any completely decoded snapshot as committed without a durability barrier.** Rejected because `write_all` can make a complete record readable before `sync_data` fails. Readability alone does not satisfy the durable-acceptance contract.
- **Weaken `accepted` to mean only present in the current snapshot.** Rejected because Issue #51 and ADR-0007 require durable acceptance; weakening the term would leave an uncertain append unresolved while presenting it as known.
- **Add a durable state-instance identity in this slice.** Deferred. The commit document is narrowly scoped store metadata that binds a published byte prefix; it does not identify the configured control-plane state instance. A separate manifest could detect a wrong but fully initialized state directory.
- **Increase the protocol or journal version.** Rejected because this adds a new capability and request kind without changing existing message or record shapes.
