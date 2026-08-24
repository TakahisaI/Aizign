//! Test doubles and shared contract checks for Aizign crates.
//!
//! Nothing here is a published artifact. The doubles implement the engine's
//! ports in memory, with fault injection so callers can prove they handle
//! `unknown` outcomes without retrying (hard invariant 3). The contract
//! checks are run by every real implementation of a port, so that an
//! in-memory double and a durable store are interchangeable in tests.

#![forbid(unsafe_code)]

pub mod conformance;
mod fixed_clock;
pub mod journal_contract;
mod memory_journal;
pub mod signals;
mod temp_dir;

pub use fixed_clock::FixedClock;
pub use memory_journal::MemoryJournal;
pub use temp_dir::TempDir;
