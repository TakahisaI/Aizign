//! Use case: classify one workflow signal from a committed journal snapshot.

use core::fmt;

use aizign_core::recovery::{SignalReconciliation, reconcile_workflow_signal as reconcile};
use aizign_core::workflow::{ApplyError, WorkflowSignal, WorkflowState};

use crate::journal::{JournalError, JournalReader};
use crate::observation::{BestEffortObserver, EngineObserver, EngineStage};

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

/// Reconciles one signal while marking the same load, replay, and decision
/// stages used by submit. Reconciliation still receives only a reader.
pub fn reconcile_workflow_signal_observed(
    journal: &mut impl JournalReader,
    signal: &WorkflowSignal,
    observer: &mut impl EngineObserver,
) -> Result<SignalReconciliation, ReconcileError> {
    let mut observer = BestEffortObserver::new(observer);
    observer.stage_started(EngineStage::JournalLoadDecode);
    let loaded = journal.load_committed_observed(&mut observer);
    observer.stage_finished(
        EngineStage::JournalLoadDecode,
        loaded.as_ref().ok().map(Vec::len),
    );
    let entries = loaded.map_err(ReconcileError::Journal)?;

    observer.stage_started(EngineStage::Replay);
    let replayed = WorkflowState::replay(entries.iter().map(|entry| &entry.event));
    observer.stage_finished(EngineStage::Replay, None);
    let state = replayed.map_err(ReconcileError::Replay)?;

    observer.stage_started(EngineStage::Decide);
    let disposition = reconcile(&state, signal);
    observer.stage_finished(EngineStage::Decide, None);
    Ok(disposition)
}
