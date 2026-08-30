# DSH submission lifecycle v1

## Status and authority

This directory is the sole normative authority for the planned DSH-owned
logical-submission lifecycle v1. It owns the lifecycle root and event-record
formats, initialization, qualification, publication and recovery ordering,
state transitions, controller projections, provisional control API, and
compatibility boundary accepted by ADR-0029.

It does **not** change Protocol v1, submit/reconciliation classification, the
core journal, store v2, or ADR-0025 trusted-value mapping. The current runtime
does not yet implement this specification; implementation is an ordered S2
migration debt.

The JSON Schemas own closed JSON value shape. This README owns algorithms,
ordering, and meaning. [`fixtures/cases.json`](fixtures/cases.json) owns the
closed executable evidence inventory and expected categories, not a second
transition algorithm.

## Ownership and non-ownership

DSH owns:

- logical submission admission and model-tool availability;
- one durable lifecycle root and its event records;
- exact pre-spawn retention of the ADR-0025 resolved pair;
- one process-local live owner and one submit/reconcile operation gate;
- lifecycle publication/recovery and the control-plane service; and
- the separate DSH lifecycle storage profile below.

DSH does not own:

- whether a signal is accepted, conflict, or absent;
- Protocol kinds, capabilities, error codes, or wire classification;
- core/journal/store state, repair, migration, or store qualification;
- automatic retry, submit-after-absent, scheduling, or multi-process
  coordination; or
- model/session/call/native identity as a lifecycle key.

## Logical identity and canonical layout

The logical identity is exactly:

```text
(lifecycleRootId, eventId)
```

Both values match the Protocol identifier pattern
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Request ID, attempt sequence, trusted
mapping key, path, and model arguments are not logical keys.

One lifecycle root intentionally supports multiple events:

```text
<lifecycleRoot>/
  lifecycle.root.json
  events/
    <event locator>.json
    <event locator>.tmp   # only while one admitted publication is live
```

The locator for `eventId` is:

```text
sha256("aizign:dsh:lifecycle-location:v1\n" + eventId)
```

encoded as 64 lowercase hexadecimal characters followed by `.json`. The
digest is a filename projection, not identity authority. The event record
retains the original `eventId`; locator/record disagreement or a digest
collision fails closed.

The only temporary name is the target locator's 64-hex basename followed by
`.tmp`. It is created exclusively in `events/`, never published as a record,
and is absent at every successful API return. There is no witness, backup,
lockfile, alternate suffix, generation file, or second temporary form. A
temporary present at startup makes that event/root fail closed; it is not
adopted, removed, or treated as proof of either the old or new state.

The root otherwise contains only the marker and `events/`. No unexpected file,
directory, symlink, hard-linked artifact, noncanonical event record, or
temporary for a different locator is accepted.

## Root marker

`lifecycle.root.json` is one LF-terminated JSON value conforming to
[`root-marker.schema.json`](schemas/root-marker.schema.json). Its fields are:

| Field | Meaning |
|---|---|
| `schemaVersion` | root-marker schema version, exactly `1` |
| `profile` | exactly `dsh-lifecycle-linux-x86_64-gnu-ext4-local-v1` |
| `lifecycleRootId` | stable operator-controlled scope identifier |
| `rootPathDigest` | lowercase SHA-256 of the exact UTF-8 bytes `"aizign:dsh:lifecycle-root-path:v1\n" + normalizedAbsoluteLifecycleRoot` |
| `eventRecordSchemaVersion` | accepted event-record version, exactly `1` |

The normalized path itself is not persisted or disclosed. The marker does not
authenticate the operator or root; it detects unsupported drift within the
trusted control-plane boundary.

The digest input has no trailing LF after the normalized path. The required
vector is:

```text
normalizedAbsoluteLifecycleRoot = /var/lib/aizign/lifecycle
rootPathDigest = b4ef74d96600260c573f7e56820762c866e5677ede2b797ccc90b8858f5173f6
```

## Event record

Each event file is one LF-terminated JSON value conforming to
[`event-record.schema.json`](schemas/event-record.schema.json). Every record
contains:

- schema version `1`;
- `lifecycleRootId` and original `eventId`;
- `configIdentity`, a domain-separated SHA-256 binding the complete validated
  signal binding and trusted configuration bundle;
- `coreStatePathKey`, a domain-separated SHA-256 binding only the configured
  normalized absolute core-state path;
- one of the ten lifecycle states; and
- `attemptSequence` from `0` through `Number.MAX_SAFE_INTEGER`.

`ready` has sequence `0` and no retained attempt. Every other state has
sequence at least `1` and retains exactly:

- the submit `requestId`;
- the complete closed Protocol submit `payload`; and
- the ADR-0025 `trustedValueMappingKey`.

The retained values are the exact values sent for that attempt. They are never
recomputed from later model input or configuration. A record contains no raw
path, root ID disclosure beyond its required binding field, DSH session/call/
thread/agent ID, prompt, model output, reasoning, environment, credential,
peer message, stderr, clock, or timing value.

`coreStatePathKey` is not a store-instance identity. Replacement of a core
path with another completely valid initialized journal is not detectable;
path selection and preservation remain trusted control-plane responsibilities.

### Canonical bindings and encoding

All lifecycle JSON produced by DSH is UTF-8, compact, in one owner-defined
property order, with canonical base-10 integer spelling and exactly one final
LF. Readers validate the exact closed JSON value shape; property order is not
semantic. Existing records that are not the mutation target are preserved
byte-for-byte. S2 must use one private encoder for initialization and every
replacement.

`configIdentity` is lowercase SHA-256 of the UTF-8 bytes:

```text
"aizign:dsh:lifecycle-config:v1\n" + canonical JSON of {
  "eventId": <binding eventId>,
  "expected": <complete validated ExpectedAssignment>,
  "trustedSignalValues": {
    "artifactRef": <validated string or null>,
    "blockedShortErrorCode": <validated string>
  }
}
```

Here `canonical JSON` is the ADR-0025 canonical JSON value: object member
names are ordered by their UTF-8 bytes recursively, arrays retain order,
strings use JSON escaping, numbers use canonical spelling, and there is no
trailing LF. The required vector is:

```text
canonical JSON = {"eventId":"evt-1","expected":{"artifactRevision":"rev-a","assignmentId":"as-impl","attemptId":"attempt-1","candidateDigest":{"algorithm":"sha256","hex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"role":"implementation","workflowId":"wf-1"},"trustedSignalValues":{"artifactRef":"artifact:implementation","blockedShortErrorCode":"BLOCKED_BY_CONTROL_PLANE"}}
configIdentity = 7b689903004bd0f652ba058372a2c8fbeb5497d8cb1cabb7d4e809490016e813
```

`coreStatePathKey` is lowercase SHA-256 of:

```text
"aizign:dsh:lifecycle-core-state-path:v1\n" + normalizedAbsoluteStateDir
```

The bytes are exact UTF-8 and have no trailing LF after the path. The required
vector is:

```text
normalizedAbsoluteStateDir = /var/lib/aizign/core
coreStatePathKey = 1f6ed774fdf931c7c8e83170243a395210ac2ed31a3e53f610931efc74482b76
```

The per-attempt `trustedValueMappingKey` is consumed unchanged from the sole
ADR-0025 resolver. These bindings are compared before preflight. They do not
authenticate the configured values or prove that a valid journal at the same
path is the original journal.

## Lifecycle storage profile

The sole lifecycle profile is:

```text
dsh-lifecycle-linux-x86_64-gnu-ext4-local-v1
```

It is distinct from the core store-v2 profile. Passing either qualifier does
not imply passing the other. The lifecycle implementation uses Node 24
standard-library facilities and no new runtime dependency.

Both configured paths must first be Unicode scalar-value strings. A lone
surrogate is rejected before filesystem access, normalization, or digest
calculation. Normalization produces an absolute POSIX path with one leading
slash, no empty, `.` or `..` component, no trailing slash except `/`, and no
NUL. `lifecycleRoot` may not be `/`, equal `stateDir`, an ancestor of
`stateDir`, or a descendant of `stateDir`.

The first-root initializer qualifies the already existing, exactly empty root
before it creates the marker, `events/`, and first record. It then qualifies
the initialized root and `events/`. A later-event initializer qualifies the
root and `events/` directly. Every startup and lifecycle mutation repeats the
applicable initialized-root qualification. In each case the implementation
must, in this order:

1. require Linux x86_64 and the repository-pinned Node/glibc boundary;
2. require normalized absolute `lifecycleRoot` and core `stateDir`; when the
   state directory does not exist, qualify its existing parent;
3. open both relevant directories with directory/no-follow semantics;
4. require lifecycle-root and `events/` effective-user ownership and exact
   mode `0700`; require marker/event/temporary artifacts to be owner-owned
   regular files with exact mode `0600` and link count one; then require the
   closed artifact set;
5. require ext-family `statfs` magic as corroboration;
6. parse the component-aligned `/proc/self/mountinfo` records for each
   descriptor path using the grammar below and select the unique deepest
   decoded mount point;
7. reject a missing record, a tie at the deepest depth, malformed escape, bind/subtree root
   (`root != /`), read-only mount or superblock, non-`ext4` filesystem type,
   or descriptor/path/device disagreement;
8. require lifecycle root and core-state parent to have the same mount ID and
   major/minor device pair; and
9. revalidate descriptor identity and marker binding around every path-based
   temporary creation and atomic replacement.

Step 1 requires `process.platform === "linux"`, `process.arch === "x64"`, a
Node version satisfying the repository engine range `>=24.19.0 <25`, and a
nonempty runtime GNU libc version reported by Node. Another libc, Node major,
architecture, or platform has no fallback and fails before state access.

### Mountinfo projection

Input is bounded to 1 MiB, split only on LF, and contains no NUL. Each record
is split at the single ` - ` separator. The required pre-separator fields are:

```text
mount-id parent-id major:minor root mount-point mount-options [optional-fields...]
```

The required post-separator fields are:

```text
filesystem-type mount-source super-options
```

Decimal IDs use canonical unsigned integer spelling. `major:minor` contains
two canonical unsigned integers. Path fields decode only the kernel octal
escapes `\040`, `\011`, `\012`, and `\134`; unknown, incomplete, or
noncanonical escapes fail. Matching uses decoded component boundaries and
selects the unique matching record whose decoded mount point has the greatest
component depth. Multiple shallower matches are permitted; no match or a tie
at the deepest depth fails. The selected record must have decoded `root` equal
to `/`, `filesystem-type` equal to `ext4`, and neither
mount nor super options may contain `ro`.

There is no realpath/statfs-only, lexical, subprocess, external-utility,
operator-assertion, network, overlay, volatile, or container-ephemeral
fallback. Qualification failure precedes mutation, hello, service/tool
publication, resolver invocation, request-ID creation, and child spawn.

Correct kernel and filesystem barrier behavior, backing persistence, same-user
namespace honesty, operator retention, and absence of external replacement are
trusted assumptions. Multiple DSH processes sharing a root are unsupported.

## Explicit initialization

Initialization is control-plane-only and never occurs during plugin startup.
The operator first creates an empty normalized absolute root with mode `0700`.
The initializer selects one of two modes from validated disk state, never from
a caller flag.

### First-root initialization

The root must be empty and qualified. The initializer exclusively:

1. creates `lifecycle.root.json` exclusively, writes its complete canonical
   value, and synchronizes that file;
2. creates `events/` and synchronizes the lifecycle-root directory;
3. writes and synchronizes the first event temporary value;
4. atomically installs the canonical event record; and
5. synchronizes `events/`.

Failure leaving any partial marker, directory, temporary, witness, or event is
not adopted or repaired. The root is fail-closed and operator-discard-only.

### Later-event initialization

The initializer fully validates the marker, profile, path/root identity,
`events/`, and every existing allowed event artifact. Existing records remain
byte-identical. The target locator must not exist or collide with a retained
`eventId`. Only the new `ready` record is installed and `events/` synchronized.

Reinitializing an event, adopting a partial setup, or modifying another event
is forbidden. No initializer lists, deletes, resets, renames, repairs, copies,
or migrates an event.

For both modes, the first event value is written to its exact `.tmp`, file-
synchronized, atomically renamed to `.json`, and followed by an `events/`
directory synchronization. A failure before the final barrier leaves the root
unsupported/operator-discard-only for first-root initialization and fail-
closed for later-event initialization. No partial image is completed on a
later call.

## Process-local ownership

After read-only validation and before recovery mutation or hello, the adapter
acquires one module-private lease for `(lifecycleRootId,eventId)`, bound to the
validated normalized root path and opened identity. A second live open in any
Cordis context or plugin instance fails before every side effect. Presenting
the same logical identity through another root/path identity is an unsupported
external reset and also fails.

The lease is neither persisted nor exported and provides no inter-process
coordination. Disposal permanently closes the controller, gates all captured
references, finishes or aborts the one admitted operation under the existing
abort contract, disposes tool/service/resources, and releases the lease last.
Closed references always return or throw fixed lifecycle unavailable without
state I/O or child work and never attach to a later controller.

## Operation gate and attempt publication

Submit and reconcile share one non-waiting controller gate covering:

```text
admission → state read → value selection → request ID → durable transition →
child spawn/wait/classification → durable result transition → projection
```

A competing call is busy and performs zero resolver, request-ID, mutation, or
child work.

An admitted submit from `ready` or `known_rejected`:

1. rejects sequence `9007199254740991` before mutation;
2. computes `nextSequence = current + 1`;
3. invokes the ADR-0025 resolver once;
4. creates one request ID;
5. writes one complete temporary `in_flight` record;
6. synchronizes the temporary file;
7. atomically replaces the canonical event record;
8. synchronizes `events/`; and
9. only then spawns the production one-shot child.

The sequence, request ID, payload, mapping key, and `in_flight` state are one
publication. A pre-spawn failure returns lifecycle unavailable, performs zero
spawn, and gates the controller. Reopening either identifies one unambiguous
authoritative image under the S2 cut-point rules or fails closed; it never
guesses `ready`.

Every later state transition uses the same owner-private encoder, same-
directory exclusive temporary creation, complete LF-terminated JSON, file
synchronization, atomic replacement, and `events/` synchronization. Known
results are exposed only after that sequence succeeds.

### Publication recovery

Each replacement has exactly these ordered cut points:

1. require no existing `.tmp` and exclusively create it;
2. write the complete canonical next record;
3. synchronize `.tmp`;
4. atomically rename `.tmp` over the canonical `.json`; and
5. synchronize `events/`.

Before step 4 is attempted, only the prior canonical image is authoritative;
the original call returns its fixed failure and a restart may accept that one
fully validated prior image, or the authorized absence for first
initialization.
Any surviving temporary or invalid/ambiguous image fails closed.

Acknowledgement uncertainty begins when step 4 is attempted, including when
the rename call returns an error, and continues through successful completion
of step 5. The original caller receives its operation-specific conservative
unknown/unavailable result and the controller becomes permanently unavailable.
On a later process startup, the filesystem may expose either one complete
prior or one complete target canonical record:
the implementation validates that single image from bytes, never infers which
rename persisted, and applies the ordinary state rule. A surviving
`in_flight` is durably replaced by `needs_reconciliation` before preflight;
known and reconciled states retain their normal projections. A missing,
malformed, mismatched, noncanonical, or accompanied-by-temp image fails closed.

No startup path deletes a temporary, reconstructs a record, compares model
arguments, guesses `ready`, or promotes an unpublished next value. This is the
complete lifecycle recovery algorithm; S2 may not add another witness or
repair path.

## States and transitions

The persisted states are exactly:

```text
ready
in_flight
known_accepted
known_duplicate
known_rejected
needs_reconciliation
reconciled_accepted
reconciled_conflict
reconciled_absent
still_unknown
```

| Prior state / trigger | Durable next state | Caller result after publication | Submit admission |
|---|---|---|---|
| explicit initialization | `ready`, sequence 0 | initialization success | yes after compatible startup |
| `ready` / `known_rejected`, admitted submit | `in_flight`, sequence + 1 | none before child result | no |
| `in_flight`, accepted | `known_accepted` | accepted | no |
| `in_flight`, duplicate | `known_duplicate` | duplicate | no |
| `in_flight`, correlated rejection or authentic local pre-transport `ProtocolError` | `known_rejected` | fixed rejected/local-validation result | yes |
| `in_flight`, any submit unknown or unexpected post-admission failure | `needs_reconciliation` | `AIZIGN_OUTCOME_UNKNOWN` | no |
| startup, persisted `in_flight` | `needs_reconciliation` before publication | none | no |
| `needs_reconciliation` / `still_unknown`, reconcile accepted | `reconciled_accepted` | status | no |
| same, conflict | `reconciled_conflict` | status | no |
| same, absent | `reconciled_absent` | status | no |
| same, reconcile unknown/abort/post-admission failure | `still_unknown` | status | no |

The eight submit-unknown reasons are no response, undecodable response,
oversized response, correlation mismatch, timeout, spawn failure, reported
unknown, and abort. All retain the gate. Startup recovery is the sole owner of
persisted `in_flight → needs_reconciliation`; externally published service
state never begins at persisted `in_flight`.

If a known submit result cannot be published, the model sees
`AIZIGN_OUTCOME_UNKNOWN`. If a known reconcile result cannot be published, the
control caller sees `AIZIGN_LIFECYCLE_UNAVAILABLE`. The controller remains
gated. Before rename attempt, restart accepts only the fully validated prior
state. From rename attempt through directory synchronization, restart accepts
exactly one fully validated prior or target state. Any temporary, missing,
malformed, mismatched, noncanonical, or ambiguous image fails closed.

Tool registration/disposal is visibility only. Every execution rechecks the
controller. `reconciled_absent` never republishes submit and authorizes no
retry, reset, or new attempt.

## Status and call projections

`status()` returns a fresh frozen in-memory projection and performs no
filesystem, resolver, Protocol, or child I/O.

| State/controller condition | `submitAvailable` | `reconciliationRequired` | Captured model call | `reconcile()` |
|---|---:|---:|---|---|
| `ready`, idle/open | true | false | admit submit | not required |
| `known_rejected`, idle/open | true | false | admit submit | not required |
| submit-admissible, gate busy | false | false | busy | busy |
| runtime `in_flight` / admitted operation | false | false | busy | busy |
| `known_accepted` / `known_duplicate` | false | false | unavailable | not required |
| `needs_reconciliation` / `still_unknown`, idle/open | false | true | reconciliation required | admit reconcile |
| reconciliation-required, gate busy | false | true | busy | busy |
| any reconciled state | false | false | unavailable | not required |
| controller unavailable/permanently closed | no status; unavailable | no status | unavailable | unavailable |

`submitAvailable` includes current admission and is false while busy.
`reconciliationRequired` is the durable semantic requirement and stays true
while reconcile owns the gate. Tool visibility is not an input. Only
`needs_reconciliation` and `still_unknown` produce model-facing
`AIZIGN_RECONCILIATION_REQUIRED`.

## Control-plane and package contract

The service name is exactly:

```text
aizignWorkflowSignalLifecycle
```

It is published only after lifecycle validation/recovery and one hello that is
compatible with both existing submit and reconcile Protocol capabilities. It
is not a model tool or prompt entry.

The planned public contract is:

```ts
type SubmissionLifecycleState =
  | 'ready' | 'in_flight'
  | 'known_accepted' | 'known_duplicate' | 'known_rejected'
  | 'needs_reconciliation'
  | 'reconciled_accepted' | 'reconciled_conflict' | 'reconciled_absent'
  | 'still_unknown';

interface SubmissionLifecycleStatus {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly state: SubmissionLifecycleState;
  readonly attemptSequence: number;
  readonly submitAvailable: boolean;
  readonly reconciliationRequired: boolean;
}

interface SubmissionLifecycleControl {
  status(): SubmissionLifecycleStatus;
  reconcile(options?: { readonly signal?: AbortSignal }): Promise<SubmissionLifecycleStatus>;
}

type SubmissionLifecycleErrorCode =
  | 'AIZIGN_LIFECYCLE_UNAVAILABLE'
  | 'AIZIGN_LIFECYCLE_BUSY'
  | 'AIZIGN_RECONCILIATION_NOT_REQUIRED';
```

`SubmissionLifecycleError` is an ordinary error that is non-subclassable by
contract. It has one exact code and fixed safe message. It has no
caller-owned cause and discloses none of the forbidden record/control values.
Reconcile from a state other than `needs_reconciliation` or `still_unknown`
throws not-required without I/O. A concurrent call throws busy. Inactive,
failed, or closed service access throws unavailable.

Captured or stale model calls after a terminal known or reconciled state,
access through an unavailable controller, and every permanently closed
reference produce exactly `AIZIGN_LIFECYCLE_UNAVAILABLE`; they never produce
reconciliation-required.

The exact planned `./experimental/lifecycle` runtime exports are:

```text
LIFECYCLE_SERVICE
SubmissionLifecycleError
getSubmissionLifecycle
initializeSubmissionLifecycle
```

The exact planned type exports are:

```text
SubmissionLifecycleControl
SubmissionLifecycleErrorCode
SubmissionLifecycleState
SubmissionLifecycleStatus
```

Exact signatures:

```ts
const LIFECYCLE_SERVICE = 'aizignWorkflowSignalLifecycle';
initializeSubmissionLifecycle(config: PluginConfig): Promise<void>;
getSubmissionLifecycle(ctx: Context): SubmissionLifecycleControl;
```

No codec, qualifier, file operation, transition, mutex, lease registry,
controller constructor, client, preflight, tool mapper, submit, reset, retry,
delete, raw record, or diagnostic is exported. The stable root and existing
`./experimental/transport` allowlist remain unchanged.

Startup capability incompatibility remains the existing preflight
`HarnessError`; no lifecycle control error duplicates `AIZIGN_INCOMPATIBLE`.

The exact model-facing lifecycle presentations are:

- `AIZIGN_LIFECYCLE_BUSY` when a competing call loses the non-waiting gate;
- `AIZIGN_RECONCILIATION_REQUIRED` for a stale/captured model call while a
  durable unknown state requires control-plane reconciliation;
- `AIZIGN_LIFECYCLE_UNAVAILABLE` for lifecycle admission/publication failure
  known to precede child spawn; and
- the existing `AIZIGN_OUTCOME_UNKNOWN` for the first semantic submit unknown
  or for a known submit result whose later lifecycle publication fails.

No raw `SubmissionLifecycleError`, filesystem/profile detail, retained value,
or cause is forwarded to the model. These are DSH presentations, not Protocol
fixed codes or new classification rows.

## Failure evidence and compatibility

The exact 134 language-neutral evidence IDs are in
[`fixtures/cases.json`](fixtures/cases.json) and validated by
[`cases.schema.json`](schemas/cases.schema.json). S2 must map each ID to exactly
one executable evidence registration and mark it executed only after its
ID-specific assertions pass. Every row also carries a required closed
`restartExpectation` and a required `parameterizedVariants` array. The schema
owns their shape; the corpus owns the exact prior/target/absence sets and
variant names. CI compares all 134 runtime categories to an explicit,
non-derived mirror, mutates each category to every other valid member, and
checks the exact restart and publication-stage mappings.

S1 records only the accepted target. Until S2 is merged:

- `PluginConfig` lacks `lifecycleRoot` and `lifecycleRootId`;
- no lifecycle root, initializer, qualifier, controller, lease, service,
  dynamic gate, or experimental lifecycle subpath exists;
- the current submit tool still calls the client directly; and
- current compatibility/support documents must not claim lifecycle-v1
  conformance.

There is no migration or compatibility mode. S2 must update runtime, exports,
the implemented error-code index, tests, and current-state documentation in one
atomic candidate after preserving this authority.
