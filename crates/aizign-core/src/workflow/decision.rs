//! `State + Command -> Decision`.

use crate::identity::EventId;
use crate::workflow::command::Command;
use crate::workflow::error::WorkflowError;
use crate::workflow::event::WorkflowEvent;
use crate::workflow::state::WorkflowState;

/// The outcome of deciding a command. Every variant is explainable; the
/// shell never has to guess (hard invariant 4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// New evidence. The shell must durably append `event` before reporting
    /// acceptance to anyone.
    Accepted {
        /// The event to append.
        event: WorkflowEvent,
    },
    /// The same identity with the same content was already accepted.
    /// Nothing to append; report as already accepted.
    Duplicate {
        /// The event id that was already accepted.
        event_id: EventId,
    },
    /// The command is rejected for the stated reason. Nothing to append.
    Rejected {
        /// Why.
        error: WorkflowError,
    },
}

/// Decides a command against the current state without changing it.
///
/// For [`Command::SubmitSignal`] the order is fixed: the signal must match
/// the expected assignment (workflow, assignment, role, revision), then its
/// event id is compared with accepted signals — same content is a
/// duplicate, different content is a conflict (hard invariant 12).
#[must_use]
pub fn decide(state: &WorkflowState, command: Command) -> Decision {
    match command {
        Command::SubmitSignal { signal, expected } => {
            if let Err(error) = signal.check_expected(&expected) {
                return Decision::Rejected { error };
            }
            match state.accepted(signal.event_id()) {
                Some(existing) if existing == &signal => Decision::Duplicate {
                    event_id: signal.event_id().clone(),
                },
                Some(_) => Decision::Rejected {
                    error: WorkflowError::EventConflict {
                        event_id: signal.event_id().clone(),
                    },
                },
                None => Decision::Accepted {
                    event: WorkflowEvent::SignalAccepted { signal },
                },
            }
        }
    }
}
