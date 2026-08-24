//! Pure, deterministic decisions for Aizign software-change workflows.
//!
//! This crate is the *functional core* of Aizign. It owns workflow state,
//! identity and binding, command validation, event application, duplicate
//! and conflict detection, next-action decisions, effect intents,
//! authorization state, and recovery dispositions.
//!
//! The basic shapes are:
//!
//! ```text
//! State + Command -> Decision
//! State + Event   -> State
//! ```
//!
//! # What this crate never does
//!
//! It performs no I/O, reads no clock, spawns no process, opens no socket,
//! reads no environment variable, runs no async runtime, and links no
//! harness, provider, or Git tooling. It also does not serialize its own
//! types: wire and journal representations are owned by `aizign-protocol`
//! and the store crates (ADR-0004).
//!
//! Most of that is enforced structurally: the crate is `#![no_std]` and
//! only uses `core` and `alloc`, so `std::fs`, `std::process`,
//! `std::net`, `std::env`, and `std::time` are simply unavailable. The
//! remaining rules (no external crates, no harness names) are checked by
//! `cargo xtask public-audit`.
//!
//! # Layout
//!
//! Modules are organized by bounded context, not by layer. See
//! `docs/architecture/context-map.md` in the repository for the map and
//! `README.md` next to this crate for responsibilities and invariants.
//!
//! # Public surface
//!
//! Only the types re-exported below are public. The shared identity
//! vocabulary lives at the crate root; each bounded context is a module.

#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

mod identity;
pub mod workflow;

pub use identity::{
    ARTIFACT_REF_MAX_LEN, ArtifactRef, ArtifactRevision, AssignmentId, AttemptId, BoundedTimestamp,
    Digest, DigestAlgorithm, EventId, IDENTIFIER_MAX_LEN, IdentityError, SHORT_ERROR_CODE_MAX_LEN,
    ShortErrorCode, WorkflowId,
};
