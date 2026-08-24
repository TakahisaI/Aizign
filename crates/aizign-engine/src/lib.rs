//! The Aizign application engine: use cases around `aizign-core`, and the ports
//! through which the shell supplies persistence, time, and effects.
//!
//! The engine owns the *ports* it needs (ADR-0005): a store crate
//! implements [`Journal`], the composition root implements the rest. The
//! engine knows no harness, provider, or wire format.

#![forbid(unsafe_code)]

mod clock;
mod handle;
mod journal;

pub use clock::{Clock, ClockError};
pub use handle::{HandleError, SignalOutcome, handle_workflow_signal};
pub use journal::{Journal, JournalEntry, JournalError, MAX_JOURNAL_ENTRIES};
