# JSONL store metadata v1

> **Historical unsupported format.** Store metadata v1 is retained only for
> compatibility-rejection evidence. The sole current/target store-layout and
> publication authority is [`../v2/`](../v2/README.md). Production implements
> v2 atomically and treats this directory only as historical evidence. A v2 binary
> rejects v1 with `JOURNAL_SCHEMA_UNSUPPORTED`; it does not adopt or migrate
> it. The schema and example in this directory remain unchanged.

`workflow.commit.json` is the writer-published commit point for
`workflow.jsonl`. It is store metadata, not a journal record and not a
Protocol v1 message.

The document is a closed JSON object:

| Field | Contract |
|---|---|
| `storeVersion` | exactly `1` |
| `committedBytes` | byte length of the authoritative JSONL prefix, `0..=67108864` |
| `committedEntries` | decoded record count in that prefix, `0..=10000` |
| `sha256` | lowercase SHA-256 of exactly the first `committedBytes` bytes |

JSON object members must not repeat, including escaped spellings of the same
decoded name. Integer fields use canonical integer tokens (`0` or a non-zero
decimal without fraction or exponent); JSON Schema sees values such as `1.0`
as integers, so these two lexical rules are enforced by the runtime decoder
and shared conformance fixtures in addition to the schema.

The writer synchronizes the journal file before publishing a commit point by
atomic replacement and then synchronizes the state directory. A reader opens
the existing lock, journal, and commit document read-only under a shared lock.
It requires the physical journal length to equal `committedBytes`, the digest
to match, and the decoded count to equal `committedEntries`.

- A shorter journal, digest mismatch, count mismatch, malformed document, or
  unknown field is `JOURNAL_CORRUPT`.
- An unsupported `storeVersion` is `JOURNAL_SCHEMA_UNSUPPORTED`.
- A journal tail beyond `committedBytes` is `JOURNAL_OUTCOME_UNKNOWN`; a
  reader never promotes, truncates, synchronizes, or repairs it.
- A reader performs no Aizign state write and does not change file contents,
  length, mtime, or the commit document. Filesystem-managed atime is outside
  this contract.
- Missing state directory, lock, journal, or commit document is
  `JOURNAL_UNAVAILABLE`, not an authoritative empty snapshot.
- Only a valid zero-entry commit point can establish an empty snapshot.
- Every state artifact is an exact-mode `0600` regular file owned by the state
  directory owner with exactly one hard link. New files are normalized from
  their open file descriptor so a restrictive process umask cannot remove
  the owner access required by a fresh process. Symbolic links and special
  files are rejected without following or opening their targets. Temporary
  commit metadata is created exclusively rather than truncating an existing
  path.

The historical implementation advertises this store only on
`x86_64-unknown-linux-gnu`, where the
barrier, atomic-replace, locking, permission, and artifact-type contract runs
in CI and the numeric Linux open-flag ABI is fixed. Other Linux ABIs,
architectures, or libc environments and non-Linux build targets do not
advertise submit or reconciliation and reject direct requests with
`CAPABILITY_UNSUPPORTED` until equivalent target-specific contract tests exist.
The x32 ABI is intentionally unsupported and is only cross-compiled in CI as a
negative boundary; this is not a runtime test, release artifact, or support
claim.

The SHA-256 value detects mismatch; it is not authentication against a process
that can rewrite both journal and commit metadata. See ADR-0013 and ADR-0014.
The broader filesystem and same-user assumptions are normative in the
[v0.1 threat model](../../../docs/security/threat-model.md).

This historical layout version is independent of Protocol v1 and journal record schema
v1. A non-empty legacy state directory without this document is not adopted
automatically. Binary downgrade against the same state directory is unsupported
and is not technically prevented: an old binary may ignore this document and
mutate `workflow.jsonl`. Operators must use a separate state directory rather
than relying on an old binary to fail closed. Preserving legacy state requires
a separately designed explicit migration or effectful recovery operation.

Fixtures under `spec/conformance/{valid,invalid}/store` are run through both
this schema and the Rust store reader. Invalid fixtures declare whether JSON
Schema can express the rejection so lexical rules cannot drift silently.
