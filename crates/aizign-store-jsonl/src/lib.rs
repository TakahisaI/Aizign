//! Append-only, metadata-only JSONL control journal with a writer-published
//! committed prefix (ADR-0007, ADR-0013).
//!
//! One record per line, owner-only permissions, shared/exclusive advisory
//! locking, durable commit metadata, and a bounded strictly read-only cold
//! reader. Record format is owned by `spec/journal/v1/`; the store commit
//! document is owned by `spec/store/v1/`. This crate follows both and
//! converts explicitly to and from `aizign-core` types (ADR-0004).

#![forbid(unsafe_code)]

mod commit;
mod journal;
mod json_member;
mod record;

pub use commit::{MAX_COMMIT_METADATA_BYTES, STORE_METADATA_VERSION};
pub use journal::{
    COMMIT_FILE_NAME, JOURNAL_FILE_NAME, JsonlJournal, JsonlJournalReader, LOCK_FILE_NAME,
    STORE_PLATFORM_SUPPORTED,
};
pub use record::{JOURNAL_SCHEMA_VERSION, decode_record, encode_record};
