//! Append-only, metadata-only JSONL control journal with a writer-published
//! committed prefix and store-v2 publication witness (ADR-0007, ADR-0028).
//!
//! One record per line, owner-only permissions, shared/exclusive advisory
//! locking, durable commit metadata, and a bounded strictly read-only cold
//! reader. Record format is owned by `spec/journal/v1/`; store layout and
//! publication are owned by `spec/store/v2/`. This crate follows both and
//! converts explicitly to and from `aizign-core` types (ADR-0004).

#![forbid(unsafe_code)]

mod commit;
#[cfg(test)]
mod crash_harness;
mod durability;
mod journal;
mod json_member;
#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
mod mountinfo;
mod observation;
mod profile;
mod publish;
mod record;
#[cfg(test)]
mod store_v2_cases;

pub use commit::{MAX_COMMIT_METADATA_BYTES, STORE_METADATA_VERSION};
pub use journal::{
    COMMIT_FILE_NAME, JOURNAL_FILE_NAME, JsonlJournal, JsonlJournalReader, LOCK_FILE_NAME,
    ObservedJsonlJournal, ObservedJsonlJournalReader, PUBLISH_FILE_NAME, STORE_PLATFORM_SUPPORTED,
};
pub use observation::{BestEffortStoreObserver, StoreObservation, StoreObserver, StoreStage};
pub use record::{JOURNAL_SCHEMA_VERSION, decode_record, encode_record};
