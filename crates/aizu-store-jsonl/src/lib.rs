//! Append-only, metadata-only JSONL control journal (ADR-0007).
//!
//! One file per state directory, one record per line, owner-only
//! permissions, an advisory lock for writer ownership, and a bounded cold
//! read. The record format is owned by `spec/journal/v1/`; this crate
//! follows it and converts explicitly to and from `aizu-core` types
//! (ADR-0004).

#![forbid(unsafe_code)]

mod journal;
mod json_member;
mod record;

pub use journal::{JOURNAL_FILE_NAME, JsonlJournal, LOCK_FILE_NAME};
pub use record::{JOURNAL_SCHEMA_VERSION, decode_record, encode_record};
