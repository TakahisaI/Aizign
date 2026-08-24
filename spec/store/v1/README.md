# JSONL store metadata v1

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
- Missing state directory, lock, journal, or commit document is
  `JOURNAL_UNAVAILABLE`, not an authoritative empty snapshot.
- Only a valid zero-entry commit point can establish an empty snapshot.

The SHA-256 value detects mismatch; it is not authentication against a process
that can rewrite both journal and commit metadata. See ADR-0013 and ADR-0014.

This layout version is independent of Protocol v1 and journal record schema
v1. A non-empty legacy state directory without this document is not adopted
automatically. Downgrade to a binary that ignores the commit point is
unsupported; preserving legacy state requires a separately designed explicit
migration or effectful recovery operation.

Fixtures under `spec/conformance/{valid,invalid}/store` are run through both
this schema and the Rust store reader. Invalid fixtures declare whether JSON
Schema can express the rejection so lexical rules cannot drift silently.
