//! Aizign Protocol v1: the NDJSON process boundary between harness adapters
//! and the `aizign` binary (ADR-0003).
//!
//! One request frame in, one response frame out. Every frame is a closed
//! schema: unknown fields, `null` in place of an omitted field, and
//! unregistered kinds are rejected with a stable error code. The wire
//! contract itself lives in `spec/protocol/v1/`; this crate follows it.
//!
//! Domain types from `aizign-core` never appear on the wire directly. The
//! DTOs here are private and converted explicitly (ADR-0004, ADR-0009).
//! ADR-0013 adds bounded read-only workflow-signal reconciliation as an
//! additive Protocol v1 kind.

#![forbid(unsafe_code)]

mod envelope;
mod error;
mod hello;
mod json_member;
mod workflow_signal;

pub use envelope::{
    BOOTSTRAP_ENVELOPE_VERSION, DecodeFailure, KIND_HELLO, KIND_WORKFLOW_SIGNAL_RECONCILE,
    KIND_WORKFLOW_SIGNAL_SUBMIT, MAX_FRAME_BYTES, MAX_REQUEST_BYTES, MAX_REQUEST_ID_LEN,
    PROTOCOL_NAME, PROTOCOL_VERSION, Request, RequestKind, Response, ResponseBody, decode_request,
    decode_response, encode_request, encode_response,
};
pub use error::{CURRENT_FIXED_ERROR_CODES, ProtocolError, codes, is_current_fixed_error_code};
pub use hello::{
    CAPABILITY_WORKFLOW_SIGNAL_RECONCILE, CAPABILITY_WORKFLOW_SIGNAL_SUBMIT, HelloInfo, PackageInfo,
};
pub use workflow_signal::{
    Disposition, ReconciliationDisposition, ReconciliationResult, SignalResult,
};
