//! Use case: handle one submitted workflow signal.
//!
//! ```text
//! load journal -> replay state -> core decides -> append (if accepted) -> outcome
//! ```

use core::fmt;

use aizign_core::EventId;
use aizign_core::workflow::{ApplyError, Command, Decision, WorkflowError, WorkflowState, decide};

use crate::clock::{Clock, ClockError};
use crate::journal::{Journal, JournalEntry, JournalError};
use crate::observation::{EngineObserver, EngineStage, NoopObserver};

/// What happened to a submitted signal. `Accepted` is returned only after
/// the entry is durable (hard invariant 2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignalOutcome {
    /// New evidence, now durable.
    Accepted {
        /// The durable entry.
        entry: JournalEntry,
    },
    /// Already accepted with identical content; nothing appended.
    Duplicate {
        /// The event id that was already accepted.
        event_id: EventId,
    },
}

/// Why a signal was not accepted. Each variant carries a stable code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HandleError {
    /// The core rejected the command (mismatch, conflict, or invalid signal).
    Rejected(WorkflowError),
    /// The journal could not be read, or the append did not complete
    /// normally. `JournalError::OutcomeUnknown` means the signal may or may
    /// not be durable; callers must not retry blindly (hard invariant 3).
    Journal(JournalError),
    /// The journal's events cannot be replayed into a consistent state.
    Replay(ApplyError),
    /// The shell could not supply a bounded timestamp.
    Clock(ClockError),
}

impl HandleError {
    /// The stable short error code.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Rejected(error) => error.code(),
            Self::Journal(error) => error.code(),
            Self::Replay(_) => "JOURNAL_CORRUPT",
            Self::Clock(_) => "INTERNAL",
        }
    }
}

impl fmt::Display for HandleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(error) => write!(f, "{error}"),
            Self::Journal(error) => write!(f, "{error}"),
            Self::Replay(error) => write!(f, "journal is corrupt: {error}"),
            Self::Clock(error) => write!(f, "{error}"),
        }
    }
}

impl core::error::Error for HandleError {}

/// Handles one `Command::SubmitSignal` end to end.
///
/// The journal is read cold every time: a one-shot process has no other
/// memory, and a long-lived one must not trust its own. Nothing is
/// appended unless the core accepts the signal, and acceptance is reported
/// only after the append returned.
pub fn handle_workflow_signal(
    journal: &mut impl Journal,
    clock: &impl Clock,
    command: Command,
) -> Result<SignalOutcome, HandleError> {
    handle_workflow_signal_observed(journal, clock, command, &mut NoopObserver)
}

/// Handles one signal while marking stage boundaries for an optional shell
/// observer. Observation cannot change the returned outcome.
pub fn handle_workflow_signal_observed(
    journal: &mut impl Journal,
    clock: &impl Clock,
    command: Command,
    observer: &mut impl EngineObserver,
) -> Result<SignalOutcome, HandleError> {
    observer.stage_started(EngineStage::JournalLoadDecode);
    let loaded = journal.load_committed_observed(observer);
    observer.stage_finished(
        EngineStage::JournalLoadDecode,
        loaded.as_ref().ok().map(Vec::len),
    );
    let entries = loaded.map_err(HandleError::Journal)?;

    observer.stage_started(EngineStage::Replay);
    let replayed = WorkflowState::replay(entries.iter().map(|entry| &entry.event));
    observer.stage_finished(EngineStage::Replay, None);
    let state = replayed.map_err(HandleError::Replay)?;

    observer.stage_started(EngineStage::Decide);
    let decision = decide(&state, command);
    observer.stage_finished(EngineStage::Decide, None);

    match decision {
        Decision::Accepted { event } => {
            let at = clock.now().map_err(HandleError::Clock)?;
            observer.stage_started(EngineStage::AppendSync);
            let appended = journal.append_observed(&event, at, observer);
            observer.stage_finished(EngineStage::AppendSync, None);
            let entry = appended.map_err(HandleError::Journal)?;
            Ok(SignalOutcome::Accepted { entry })
        }
        Decision::Duplicate { event_id } => Ok(SignalOutcome::Duplicate { event_id }),
        Decision::Rejected { error } => Err(HandleError::Rejected(error)),
    }
}
