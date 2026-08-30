# ADR-0028: Define crash-monotonic JSONL publication

- Status: Accepted
- Date: 2026-08-29
- Related: ADR-0007, ADR-0013, ADR-0014, ADR-0015, ADR-0019, Issue #81

## Context

Store metadata v1 publishes a synchronized journal prefix by replacing
`workflow.commit.json` and then synchronizing the state directory. The new
name can become visible before that directory barrier succeeds. Visibility is
therefore not, by itself, crash-monotonic evidence that the namespace update
survives a later machine crash.

The writer also retained decoded snapshot authority across append calls, so a
same-instance second append could skip a complete physical reread after an
external mutation. Finally, the existing target-triple gate did not identify
the filesystem, mount, or backing-storage assumptions required by file and
directory barriers.

Issue #81 accepted a pre-release store-layout break that retains one JSONL
journal while closing those physical publication and support boundaries.

## Decision

Adopt the store metadata v2 authority in [`spec/store/v2/`](../../spec/store/v2/README.md).
The journal record stream remains schema v1 and remains the only workflow
acceptance store.

The v2 artifact set adds a pre-existing publication witness:

```text
workflow.lock
workflow.jsonl
workflow.commit.json   storeVersion=2, generation and exact prefix authority
workflow.publish.json  PREPARED/CLEAN generation witness
```

Generation equals committed entry count plus one. The witness is either clean
`W=(G,G)`, initializing `W=(1,0)`, or one prepared successor `W=(G+1,G)`.
Reverse, skipped, malformed, or contradictory values fail closed.

### Publication ordering

Under the existing exclusive non-blocking lock, every append performs a full
physical and decoded revalidation and then:

1. writes and synchronizes PREPARED `W=(G+1,G)`;
2. writes one journal record and synchronizes the journal;
3. writes and synchronizes temporary commit metadata;
4. atomically replaces the commit document and synchronizes the state
   directory; and
5. writes and synchronizes CLEAN `W=(G+1,G+1)`.

Append success is returned only after the final verification. Failure after
the first PREPARED byte is attempted is `JOURNAL_OUTCOME_UNKNOWN` and never
authorizes retry. At generation 10001 the next append returns
`JOURNAL_BOUND_EXCEEDED` before mutation.

A visible final CLEAN rewrite may be used by a later fully revalidating reader
even if that rewrite's own final synchronization reported failure. This is a
bounded exception: PREPARED, the journal barrier, the commit temporary-file
barrier, the atomic replacement, and the commit namespace's directory barrier
must already be durable. A crash may weaken CLEAN to PREPARED/unknown; it
cannot restore a contradictory older known commit point. No other visible but
unsynchronized metadata is authority.

### Initialization

Zero-entry initialization is a separate closed machine. It qualifies the
parent, creates and requalifies the state directory, durably creates lock and
empty journal, publishes durable v2 `C=1`, durably creates PREPARED `W=(1,0)`,
and only then writes CLEAN `W=(1,1)`.

The v2 commit marker is the downgrade fence for a complete v2 store. State
left before that marker is durable is not fenced and is unsupported,
operator-discard-only state.

Visible `W=(1,0)` never proves its past durability. An exclusive reopening
writer must revalidate and synchronize the witness inode, reread it,
synchronize the state directory, and revalidate the path/inode/mount/content
identity before CLEAN. Failure forbids CLEAN and every other mutation.

Initialization failure before generation-2 PREPARED is
`JOURNAL_UNAVAILABLE` for the triggering operation because no signal append
has started. A later reader independently classifies incomplete initialization
as unavailable, malformed state as corrupt, unsupported versions as schema
unsupported, and only exact clean generation 1 as known `absent`.

### Read authority and revalidation

Readers retain the shared non-blocking lock through profile, witness, commit,
physical-prefix, digest, count, and decode validation. They are strictly
read-only and never initialize, synchronize, repair, truncate, promote, or
release a prepared generation.

Before every append on the same writer instance, the store reopens/rereads and
revalidates profile identity; artifact type, owner, mode, link, device, mount,
and inode identity; witness and commit bytes; journal length and exact prefix
SHA-256; decoded records and sequence; and absence of a tail. Cached decoded
state cannot serve as durable authority. Coordinated same-user forgery of all
artifacts remains outside the guarantee.

### Supported storage profile

The sole v0.1 profile is `linux-x86_64-gnu-ext4-local-v1`.

Runtime qualification is fd-bound. On exact
`x86_64-unknown-linux-gnu`/64-bit, the store calls safe
`rustix::fs::statx` with `AT_EMPTY_PATH` on the opened directory, requires a
returned `STATX_MNT_ID`, binds that ID to exactly one bounded
`/proc/self/mountinfo` record, requires exact `fs_type=ext4`, requires
read-write per-mount and superblock options, checks device agreement, and uses
the shared ext-family `statfs` magic only as corroboration. Missing `statx`, a
missing returned mask bit, unusable mountinfo, ambiguity, read-only state, or
identity inconsistency is `JOURNAL_UNAVAILABLE` before mutation. There is no
magic-only, lexical-path, subprocess, external-utility, or
`/proc/self/fdinfo` fallback.

Runtime requalifies before creation, after creating the state directory, on
writer open, before each PREPARED transition, and before each reader authority
read. Framed `hello` remains state-independent; a path failure is not
capability absence or known `absent`.

Backing-device persistence across restart, correct controller/hypervisor flush
behavior, barrier-preserving policy, and absence of unsupported copy/restore
or coordinated same-user mutation remain explicit operator assumptions.

### Exact dependency

S2 must use exactly:

```toml
[workspace.dependencies]
rustix = {
  version = "=1.1.4",
  default-features = false,
  features = ["std", "fs"],
}
```

Only `aizign-store-jsonl` may own this direct runtime dependency. It is the
Bytecode Alliance `rustix` crate from crates.io, version 1.1.4, with minimum
supported Rust version 1.63 and license expression
`Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`. The exact expected lock
resolution is:

```text
rustix 1.1.4
bitflags 2.13.1
linux-raw-sys 0.12.1
errno 0.3.14
libc 0.2.189
windows-sys 0.61.2
windows-link 0.2.1
```

On the supported target, the reachable normal graph is exactly
`rustix -> {bitflags, linux-raw-sys}`. `libc 0.2.189` already exists in the
accepted base lockfile and is not a new S2 package. The supported build must
contain neither `rustix_use_libc` nor `rustix_no_linux_raw`. Pinned
`cargo-deny 0.20.2` must pass licenses, advisories, bans, and sources for the
resolved graph.

Aizign-owned unsafe code remains forbidden. No repository-local FFI, syscall
wrapper, alternative binding, external utility, subprocess, or silent backend
substitution is authorized. Any dependency version, feature, source, license,
minimum-Rust-version, resolution, backend cfg, or supported-target reachable
graph drift is a stop condition and requires a renewed decision.

S1 recorded this dependency decision without changing manifests. The Issue
#81 S2 candidate of 2026-08-29 implements the exact dependency declaration,
lock resolution, machine audit, v2 state machine, and supported-profile gate
as one atomic change; this note does not alter the Accepted decision above.

### Compatibility and ownership

Store metadata v1 is an unsupported historical format retained for rejection
evidence. The v2 implementation does not silently adopt, migrate, dual-read,
repair, truncate, or promote old or ambiguous state. A complete v2 commit
marker makes the current v1 binary fail its unsupported-version check; a
pre-marker partial directory is not fenced.

ADR-0013 remains controlling for exact-signal reconciliation, known
dispositions, unknown non-collapse, no retry, read-only reconciliation, and no
repair/promotion. This ADR supersedes its physical store metadata, layout,
initialization, publication, reader-known conditions, physical failure-stage
classification, support profile, and v1/v2 compatibility clauses.

This ADR also supersedes ADR-0015 only where it described target-triple-only
store support and the absence of a complete-v2 downgrade fence. ADR-0015's
guarantee-level and trust-boundary model remains Accepted. ADR-0014 remains
the SHA-256 owner. ADR-0019 remains the physical-observation owner.

The store owns one production I/O path and the internal publication cut points
needed by Issue #82. Public Protocol, classification, client outcomes, retry,
and provisional timing do not gain store-layout authority. Issue #82 remains
ordered after complete Issue #81 S2 and owns real child-process SIGKILL,
partial-write, two-process, and barrier-mutation evidence.

## Consequences

### Positive

- A known result is tied to a clean generation whose journal and commit
  namespace completed the required barriers.
- Crash loss can weaken a result to unknown without producing a contradictory
  older known result.
- Same-instance appends cannot hide an intervening physical mutation behind a
  cached snapshot.
- Support claims name the exact runtime-detectable ext4 boundary and the
  remaining operator assumptions.
- Complete v2 state is fenced from the current v1 binary without adding a
  migration or a second store.

### Negative / risks

- Each append performs a bounded cold reread and additional witness barriers.
- Supported operation is deliberately limited to one Linux/ext4 profile.
- A prepared or tailed store fails closed and is not automatically recovered.
- Pre-marker partial initialization is not technically fenced.
- Advisory locks and SHA-256 do not protect against a coordinated malicious
  same-user rewrite.

## Alternatives considered

- **Treat visible rename as durable authority.** Rejected because visibility
  can precede the state-directory barrier.
- **Use a second database or recovery service.** Rejected; one JSONL store and
  one production I/O path remain sufficient.
- **Repair or promote prepared state on read.** Rejected because reconciliation
  is read-only and uncertainty must not become an implicit effect.
- **Use filesystem magic alone.** Rejected because ext2/ext3/ext4 share the
  magic and it does not bind the opened directory to one mount record.
- **Use local unsafe syscall code or an external utility.** Rejected in favor
  of the exact reviewed safe `rustix` dependency.
- **Automatically migrate v1.** Rejected; preservation requires a separately
  accepted design.
