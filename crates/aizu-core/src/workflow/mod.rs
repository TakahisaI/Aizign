//! The workflow context: structured workflow signals and the decisions the
//! core makes about them.
//!
//! ```text
//! WorkflowState + Command       -> Decision
//! WorkflowState + WorkflowEvent -> WorkflowState
//! ```
//!
//! A [`WorkflowSignal`] is structured evidence submitted by a harness on
//! behalf of a role. The core compares it with the [`ExpectedAssignment`]
//! the shell is bound to, then decides whether it is newly accepted, an
//! exact duplicate, or a conflict (hard invariant 12). The core never
//! infers completion from anything but such a signal (hard invariant 1).

mod command;
mod decision;
mod error;
mod event;
mod signal;
mod state;

pub use command::Command;
pub use decision::{Decision, decide};
pub use error::{InvalidSignal, WorkflowError};
pub use event::WorkflowEvent;
pub use signal::{ExpectedAssignment, Role, SignalKind, SignalParts, WorkflowSignal};
pub use state::{ApplyError, WorkflowState};
