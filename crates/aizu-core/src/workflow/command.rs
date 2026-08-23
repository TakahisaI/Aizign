//! Commands the shell can ask the workflow context to decide on.

use crate::workflow::signal::{ExpectedAssignment, WorkflowSignal};

/// A request for a decision. Commands carry everything the decision needs;
/// the core reads nothing else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// A harness submitted a structured signal for the assignment the shell
    /// is bound to.
    SubmitSignal {
        /// The validated signal.
        signal: WorkflowSignal,
        /// The assignment the shell expects signals for.
        expected: ExpectedAssignment,
    },
}
