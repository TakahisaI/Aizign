//! The `hello` handshake: what this binary speaks and can do.

use serde::{Deserialize, Serialize};

/// Capability advertised when `workflow.signal.submit` is available.
pub const CAPABILITY_WORKFLOW_SIGNAL_SUBMIT: &str = "workflow.signal.submit";

/// The `hello` response payload. Adapters decide compatibility from
/// `protocol_version` and `capabilities`, never from `package.version`
/// (ADR-0003, ADR-0008).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HelloInfo {
    /// Wire protocol version this binary speaks.
    pub protocol_version: u32,
    /// Journal schema version this binary reads and writes.
    pub journal_schema_version: u32,
    /// Request kinds this binary accepts beyond `hello`.
    pub capabilities: Vec<String>,
    /// Informational package identity; not used for compatibility.
    pub package: PackageInfo,
}

/// Informational identity of the responding package.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PackageInfo {
    /// Package name, e.g. `aizu`.
    pub name: String,
    /// Package version, e.g. `0.1.0`.
    pub version: String,
}
