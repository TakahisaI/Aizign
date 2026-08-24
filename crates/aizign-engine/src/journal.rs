//! The control-journal port: append-only, metadata-only, bounded.

use core::fmt;

use aizign_core::BoundedTimestamp;
use aizign_core::workflow::WorkflowEvent;

/// Upper bound on entries a single cold read may return. Exceeding it is an
/// error, not a truncation: a journal that large needs a different store.
pub const MAX_JOURNAL_ENTRIES: usize = 10_000;

/// One durable entry, in append order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalEntry {
    /// 1-based, contiguous sequence number assigned by the store.
    pub seq: u64,
    /// When the shell appended the entry.
    pub at: BoundedTimestamp,
    /// The event itself.
    pub event: WorkflowEvent,
}

/// Why a journal operation did not complete normally. Every variant maps to
/// a stable code; `OutcomeUnknown` in particular must never be retried
/// blindly (hard invariant 3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JournalError {
    /// The store cannot be opened or used at all (missing artifact, wrong
    /// permissions, unsupported platform, or I/O failure before append).
    Unavailable {
        /// What went wrong, without file contents.
        detail: String,
    },
    /// Another process holds an incompatible journal lock.
    Locked,
    /// A journal-record or store-metadata schema version is unsupported.
    SchemaUnsupported {
        /// The unsupported version found at the storage boundary.
        found: u64,
    },
    /// Journal contents or store metadata are inconsistent with their
    /// closed schemas and published commit point.
    Corrupt {
        /// What is wrong, without record contents.
        detail: String,
    },
    /// The journal holds more entries than a bounded cold read allows.
    BoundExceeded {
        /// The bound that was exceeded.
        max: usize,
    },
    /// An append may or may not have reached the published commit point, or
    /// an unpublished tail was observed. Treat it as unknown, not retryable.
    OutcomeUnknown {
        /// What was observed, without record contents.
        detail: String,
    },
}

impl JournalError {
    /// The stable short error code.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Unavailable { .. } => "JOURNAL_UNAVAILABLE",
            Self::Locked => "JOURNAL_LOCKED",
            Self::SchemaUnsupported { .. } => "JOURNAL_SCHEMA_UNSUPPORTED",
            Self::Corrupt { .. } => "JOURNAL_CORRUPT",
            Self::BoundExceeded { .. } => "JOURNAL_BOUND_EXCEEDED",
            Self::OutcomeUnknown { .. } => "JOURNAL_OUTCOME_UNKNOWN",
        }
    }
}

impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable { detail } => write!(f, "journal unavailable: {detail}"),
            Self::Locked => f.write_str("journal is locked by another process"),
            Self::SchemaUnsupported { found } => {
                write!(f, "journal/store schema version {found} is not supported")
            }
            Self::Corrupt { detail } => write!(f, "journal is corrupt: {detail}"),
            Self::BoundExceeded { max } => {
                write!(f, "journal exceeds the cold-read bound of {max} entries")
            }
            Self::OutcomeUnknown { detail } => write!(f, "append outcome unknown: {detail}"),
        }
    }
}

impl core::error::Error for JournalError {}

/// Read-only access to a writer-published committed journal snapshot.
pub trait JournalReader {
    /// Bounded cold read of every committed entry.
    ///
    /// Implementations must not initialize, write, synchronize, repair, or
    /// promote journal state while serving this operation.
    fn load_committed(&mut self) -> Result<Vec<JournalEntry>, JournalError>;
}

/// The append-capable control journal as the engine sees it.
///
/// Implementations must be append-only and metadata-only (ADR-0007):
/// `append` returns `Ok` only once the entry is durable, and
/// [`JournalReader::load_committed`] returns entries in append order with
/// contiguous `seq` values starting at 1.
pub trait Journal: JournalReader {
    /// Durably appends one event, stamped with the shell-supplied time.
    fn append(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
    ) -> Result<JournalEntry, JournalError>;
}

#[cfg(test)]
mod tests {
    use super::JournalError;
    use aizign_core::ShortErrorCode;

    #[test]
    fn every_code_is_a_valid_short_error_code() {
        let errors = [
            JournalError::Unavailable {
                detail: String::new(),
            },
            JournalError::Locked,
            JournalError::SchemaUnsupported { found: 2 },
            JournalError::Corrupt {
                detail: String::new(),
            },
            JournalError::BoundExceeded { max: 1 },
            JournalError::OutcomeUnknown {
                detail: String::new(),
            },
        ];
        for error in errors {
            assert!(
                ShortErrorCode::new(error.code()).is_ok(),
                "{}",
                error.code()
            );
            assert!(!error.to_string().is_empty());
        }
    }
}
