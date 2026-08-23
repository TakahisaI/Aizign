//! Domain events: the only things that change workflow state, and the only
//! things the shell persists for this context.

use crate::workflow::signal::WorkflowSignal;

/// Something that happened to the workflow and was durably recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkflowEvent {
    /// A signal was accepted as new evidence.
    SignalAccepted {
        /// The accepted signal.
        signal: WorkflowSignal,
    },
}
