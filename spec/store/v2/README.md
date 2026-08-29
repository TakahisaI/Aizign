# JSONL store metadata v2

This directory is the sole current/target authority for Aizign's JSONL store
layout and crash-monotonic publication contract. The README, the two closed
schemas, the examples, and the closed language-neutral case corpus form one
versioned authority package. Implementations may project this authority into
tests; they must not create a second lifecycle or classification table.

Store metadata version 2 is independent of Protocol v1, journal record schema
v1, process profile v1, and package versions. The journal remains the single
append-only `workflow.jsonl` stream defined by
[`../../journal/v1/`](../../journal/v1/README.md).

S1 publishes this target contract. Until the ordered S2 migration is merged,
the production store still implements the historical v1 layout and is not
profile-qualified under this document.

## Artifact set and physical rules

All artifacts are in one owner-only state directory:

```text
<state dir>/                  owner-only directory, exact mode 0700
├── workflow.lock            existing advisory lock, exact mode 0600
├── workflow.jsonl           journal schema v1, exact mode 0600
├── workflow.commit.json     store metadata v2, exact mode 0600
└── workflow.publish.json    publication witness v2, exact mode 0600
```

Every reserved artifact is a regular file owned by the effective state owner,
has the required exact mode and one hard link, is opened without following a
symbolic link, and remains on the qualified state-directory device and mount.
Temporary commit metadata is an owner-only regular file created exclusively
on the same directory and is not a second authority.

The store uses canonical JSON integer tokens: `0`, or a non-zero base-10
integer with no leading zero, fraction, or exponent. Object members are
unique by decoded member name. Unknown members, duplicate members, noncanonical
integers, invalid bounds, malformed JSON, or contradictory relationships fail
closed even where JSON Schema cannot express the lexical or cross-field rule.

## Commit metadata

`workflow.commit.json` is a closed document:

| Field | Contract |
|---|---|
| `storeVersion` | exactly `2` |
| `generation` | integer `1..=10001` |
| `committedBytes` | authoritative JSONL prefix length, `0..=67108864` |
| `committedEntries` | decoded records in that prefix, `0..=10000` |
| `sha256` | exact lowercase SHA-256 of the first `committedBytes` bytes |

The relation is always:

```text
generation == committedEntries + 1
```

Generation 1 is the zero-entry commit point. Generation 10001 is the maximum
clean point and contains exactly 10000 records.

## Publication witness

`workflow.publish.json` is a separate pre-existing publication object after
initialization. It is a closed document:

| Field | Contract |
|---|---|
| `storeVersion` | exactly `2` |
| `startedGeneration` | integer `1..=10001` |
| `publishedGeneration` | integer `0..=10001` |

Let `W=(startedGeneration,publishedGeneration)`. The only structurally valid
relations are:

- initialization PREPARED: `W=(1,0)`;
- CLEAN generation `G`: `W=(G,G)`; or
- append PREPARED for one successor: `W=(G+1,G)`.

Reverse, skipped, or otherwise inconsistent generations are corruption.
`publishedGeneration: 0` is permitted only during zero-entry initialization.

## Clean authority

A reader may return a known workflow disposition only when all of the
following are revalidated under the shared non-blocking lock:

```text
W=(G,G)
C.generation=G
C.committedEntries=G-1
physical journal length=C.committedBytes
SHA-256(prefix)=C.sha256
decoded valid record count=C.committedEntries
no bytes exist after the committed prefix
```

The reader also completes the storage-profile and artifact checks described
below. It is strictly observational: it never creates, synchronizes, rewrites,
repairs, truncates, promotes, completes initialization, or releases a PREPARED
generation. Filesystem-managed access time is outside this contract.

## Append publication order

An append owns exactly one transition from clean generation `G` to clean
generation `G+1` under the existing exclusive non-blocking lock. Before every
append, including a second append on the same object instance, the store
reopens/rereads and revalidates the profile, every artifact identity, witness,
commit document, physical length, exact prefix digest, decoded entry count and
sequence, and absence of an unpublished tail. Cached values cannot skip this
authority read.

After that revalidation, the only permitted order is:

1. rewrite the pre-existing witness as PREPARED `W=(G+1,G)`;
2. synchronize that witness inode and reread/verify the stored PREPARED image;
3. write exactly one complete next journal record and synchronize the journal;
4. write the `G+1` commit document to the owner-only temporary path and
   synchronize that temporary file;
5. atomically replace `workflow.commit.json`;
6. synchronize the state directory, making the new commit namespace entry
   durable;
7. rewrite the same witness inode as CLEAN `W=(G+1,G+1)` and synchronize it;
8. reread/verify CLEAN and only then return append success.

The writer does not write CLEAN when any journal, commit-temporary, rename, or
state-directory barrier fails. After the first byte of the PREPARED rewrite
has been attempted, an I/O or profile failure is
`JOURNAL_OUTCOME_UNKNOWN` and never authorizes automatic retry.

At clean generation 10001, the next append returns
`JOURNAL_BOUND_EXCEEDED` before any write. Every artifact remains unchanged.

### Bounded visible-CLEAN exception

The final CLEAN rewrite may become visible before its own `sync_all` returns.
A later reader may nevertheless use that exact CLEAN image after complete
revalidation because the PREPARED witness inode/entry, journal record and
journal barrier, commit temporary contents, atomic replacement, and commit
namespace directory barrier were all durable before CLEAN was attempted.

A crash may lose only that final release-marker rewrite and weaken the result
from known to unknown. It cannot restore an older commit namespace entry or
produce a contradictory known journal fact. This exception applies only to
the final CLEAN rewrite; visible unsynchronized PREPARED or renamed metadata
is never authority.

## Zero-entry initialization

Initialization has no workflow-signal state effect. No signal decision or
journal append begins until generation 1 is CLEAN.

Fresh initialization is permitted only when no reserved artifact exists in a
qualified directory. Under the exclusive lock it performs this exact order:

1. qualify the nearest existing parent without creating the state directory;
2. create/open the state directory if needed, requalify it on the same mount
   and device, create the lock and empty journal, synchronize new files, and
   synchronize the state directory and parent for new namespace entries;
3. publish exact empty `C=1` using a synchronized temporary file, atomic
   same-directory replacement, and a successful state-directory sync;
4. create `workflow.publish.json` as `W=(1,0)`, synchronize and verify that
   inode, synchronize the state directory, and revalidate path, inode, mount,
   and exact contents; and
5. rewrite the same inode as `W=(1,1)`, synchronize and verify CLEAN, then
   report initialization success.

The durable v2 commit marker is published before the witness so an old v1
binary rejects a complete v2 store before appending. Interruption before that
marker is durable is not technically fenced; such pre-marker partial state is
unsupported and operator-discard-only.

The only writer-completable initialization images are:

- exact empty `C=1`, exact empty journal, no witness;
- exact empty `C=1`, exact empty journal, visible exact `W=(1,0)`; and
- exact empty `C=1`, exact empty journal, exact `W=(1,1)`.

For visible `W=(1,0)`, a later process never infers past durability from
visibility. Under the exclusive lock it must fd-open and revalidate the exact
witness, synchronize that inode, reread it, synchronize the state directory,
reopen/revalidate that the path still names the same inode on the same mount
with exact contents, and only then write CLEAN. Any failure forbids CLEAN and
all other state mutation.

Initialization failure before the first byte of generation-2 PREPARED is
`JOURNAL_UNAVAILABLE` for the triggering operation. It never says the signal
may have been applied. The later image is classified independently:

- missing required initialization artifact or exact `W=(1,0)`:
  `JOURNAL_UNAVAILABLE`;
- malformed or contradictory v2 artifact: `JOURNAL_CORRUPT`;
- unsupported commit version: `JOURNAL_SCHEMA_UNSUPPORTED`; and
- exact CLEAN generation 1: the only authoritative `absent` image.

## Existing-image matrix

| Image | Reader result | Writer permission |
|---|---|---|
| CLEAN `W=(G,G)`, matching `C=G`, exact journal `G` | known result from exact prefix | one append after full revalidation |
| PREPARED `W=(G+1,G)` at any allowed single-append cut point | `JOURNAL_OUTCOME_UNKNOWN` | none on reopen |
| CLEAN metadata with extra journal tail | `JOURNAL_OUTCOME_UNKNOWN` | none |
| Missing required artifact | `JOURNAL_UNAVAILABLE` | only the exact initialization cases above |
| Malformed or impossible v2 image | `JOURNAL_CORRUPT` | none |
| Unsupported store version, including v1 | `JOURNAL_SCHEMA_UNSUPPORTED` | none |
| Clean generation 10001 on append request | existing known result; append returns `JOURNAL_BOUND_EXCEEDED` | none |

Version probing of an existing commit document precedes the missing-v2-witness
check, so a v1 commit cannot be misclassified as ordinary unavailability. A
reader never turns a missing store into `absent` and never converts a profile
failure into a capability result.

## Supported storage profile

The sole v0.1 profile is `linux-x86_64-gnu-ext4-local-v1`.

Runtime-enforced requirements are:

1. exact target `x86_64-unknown-linux-gnu` and 64-bit pointer width;
2. open the state directory, or nearest existing parent for a fresh path, as a
   no-follow directory fd;
3. use safe `rustix::fs::statx` on that opened fd with an empty path,
   `AT_EMPTY_PATH`, `STATX_MNT_ID`, and required basic fields;
4. require the returned mask to contain `STATX_MNT_ID`; `NOSYS`, a missing
   bit, call failure, or unusable ID is unavailable;
5. parse bounded `/proc/self/mountinfo` and bind the ID to exactly one record;
6. require exact `fs_type=ext4`, per-mount options containing `rw` and not
   `ro`, and superblock options not containing `ro`;
7. require mountinfo and opened-directory device major/minor to agree;
8. require `statfs` on the same opened fd to report ext-family magic as a
   corroborative check only; and
9. require every artifact, and a newly created state directory, to retain the
   same qualified mount/device and physical rules.

The complete check runs before state creation, after a new state directory is
created, at every writer open, before every append PREPARED transition, and
before every reader authority read. Missing/unreadable/malformed/ambiguous
mount information or any changed identity fails `JOURNAL_UNAVAILABLE` before
mutation. There is no filesystem-magic-only, lexical-path,
`/proc/self/fdinfo`, subprocess, or external-utility fallback.

Operator-trusted assumptions, not claimed as runtime proofs, are:

- the ext4 backing device is local and persists across host restart;
- filesystem/device/controller/hypervisor barriers honor successful syncs;
- mount or storage policy does not weaken those barriers; and
- no unsupported copy/restore or coordinated same-user rewrite occurs.

Qualification evidence is closed and non-sensitive. It may record target
triple, kernel release, filesystem magic/type, relevant read-only/barrier
status when detectable, and harness version. It must not record state paths,
mount sources, journal contents, request payloads, or private host data.

Framed `hello` remains state-independent. A capability says the binary
implements the operation; it does not attest to a particular `--state` path.
Path qualification failure is `JOURNAL_UNAVAILABLE`, never
`CAPABILITY_UNSUPPORTED`, known `absent`, or retry authorization.

## Dependency decision for S2

[ADR-0028](../../../docs/adr/0028-define-crash-monotonic-jsonl-publication.md)
solely owns the accepted future dependency decision. S1 records that decision
but does not change a manifest, lockfile, current dependency allowlist, or
machine audit; the dependency is not current runtime state, and those changes
are atomic S2 work.

## Compatibility and non-goals

Store v1 is an unsupported historical format retained for compatibility
rejection evidence. The v2 binary does not silently adopt, migrate, repair,
truncate, promote, or dual-read v1 or ambiguous state. A complete v2 commit
marker makes the current v1 binary fail its unsupported-version check. A
pre-marker partial directory is not fenced and must be discarded by the
operator. Preserving old state requires a separately accepted design.

This contract adds no Protocol code, client outcome, retry rule, public timing
vocabulary, second store, recovery service, or generic filesystem profile.
Issue #82, ordered after complete S2, owns real child-process SIGKILL,
partial-write, two-process, and barrier-mutation evidence against the one
production I/O path.

## Files

- `schemas/commit.schema.json` — closed commit-document shape and bounds.
- `schemas/publish.schema.json` — closed witness shape and bounds.
- `examples/` — fictional clean generation-1 documents.
- `fixtures/cases.schema.json` — closed language-neutral case shape.
- `fixtures/cases.json` — exactly 38 normative state/profile/revalidation
  cases. IDs may not be renamed, combined, or interpreted differently by S2.
