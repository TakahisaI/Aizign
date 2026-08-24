//! Use case: classify one workflow signal from a committed journal snapshot.

use core::fmt;

use aizign_core::recovery::{SignalReconciliation, reconcile_workflow_signal as reconcile};
use aizign_core::workflow::{ApplyError, WorkflowSignal, WorkflowState};

use crate::journal::{JournalError, JournalReader};

/// Why reconciliation could not obtain a trustworthy semantic result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReconcileError {
    /// The committed snapshot could not be loaded completely.
    Journal(JournalError),
    /// The committed events do not replay into a consistent state.
    Replay(ApplyError),
}

impl ReconcileError {
    /// The stable short error code.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Journal(error) => error.code(),
            Self::Replay(_) => "JOURNAL_CORRUPT",
        }
    }
}

impl fmt::Display for ReconcileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Journal(error) => write!(f, "{error}"),
            Self::Replay(error) => write!(f, "journal is corrupt: {error}"),
        }
    }
}

impl core::error::Error for ReconcileError {}

/// Replays one committed snapshot and classifies the exact queried signal.
pub fn reconcile_workflow_signal(
    journal: &mut impl JournalReader,
    signal: &WorkflowSignal,
) -> Result<SignalReconciliation, ReconcileError> {
    let entries = journal.load_committed().map_err(ReconcileError::Journal)?;
    let state = WorkflowState::replay(entries.iter().map(|entry| &entry.event))
        .map_err(ReconcileError::Replay)?;
    Ok(reconcile(&state, signal))
}
