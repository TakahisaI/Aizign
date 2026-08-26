//! The Aizign application engine: current signal submit/reconcile use cases and
//! the journal, clock, and optional observation ports supplied by the shell.
//!
//! No external-effect port or operation is part of the current engine.
//!
//! The engine owns the *ports* it needs (ADR-0005): a store crate implements
//! [`JournalReader`] and [`Journal`], while the composition root implements
//! the rest. Reconciliation accepts only the read capability. The engine
//! knows no harness, provider, or wire format.

#![forbid(unsafe_code)]

mod clock;
mod handle;
mod journal;
mod observation;
mod reconcile;

pub use clock::{Clock, ClockError};
pub use handle::{
    HandleError, SignalOutcome, handle_workflow_signal, handle_workflow_signal_observed,
};
pub use journal::{Journal, JournalEntry, JournalError, JournalReader, MAX_JOURNAL_ENTRIES};
pub use observation::{BestEffortObserver, EngineObserver, EngineStage};
pub use reconcile::{
    ReconcileError, reconcile_workflow_signal, reconcile_workflow_signal_observed,
};
