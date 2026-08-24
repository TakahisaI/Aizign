//! Pure recovery decisions over a completely replayed workflow snapshot.

use crate::workflow::{WorkflowSignal, WorkflowState};

/// What a trustworthy workflow snapshot says about one signal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignalReconciliation {
    /// The same event identity and exact signal content are present.
    Accepted,
    /// The event identity is present with different signal content.
    Conflict,
    /// No event with that identity is present.
    Absent,
}

/// Classifies a signal against a fully replayed workflow snapshot.
///
/// This function is deliberately incapable of returning `unknown`: failure
/// to obtain a complete, trustworthy snapshot belongs to the shell.
#[must_use]
pub fn reconcile_workflow_signal(
    state: &WorkflowState,
    signal: &WorkflowSignal,
) -> SignalReconciliation {
    match state.accepted(signal.event_id()) {
        Some(accepted) if accepted == signal => SignalReconciliation::Accepted,
        Some(_) => SignalReconciliation::Conflict,
        None => SignalReconciliation::Absent,
    }
}
