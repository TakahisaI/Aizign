//! The Aizu application engine: use cases around `aizu-core`, and the ports
//! through which the shell supplies persistence, time, and effects.
//!
//! The engine owns the *ports* it needs (ADR-0005): a store crate
//! implements [`Journal`], the composition root implements the rest. The
//! engine knows no harness, provider, or wire format.

#![forbid(unsafe_code)]

mod journal;

pub use journal::{Journal, JournalEntry, JournalError, MAX_JOURNAL_ENTRIES};
