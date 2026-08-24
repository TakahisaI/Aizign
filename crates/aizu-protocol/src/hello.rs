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

impl HelloInfo {
    /// Contract checks past serde's shape (kept identical to
    /// `spec/protocol/v1/schemas/hello.response.schema.json`): versions start
    /// at 1, capability names are well formed and unique. The capability
    /// *list* stays open so a client can still decode the handshake of a
    /// newer binary; compatibility is decided afterwards by the caller.
    pub fn validate(&self) -> Result<(), String> {
        if self.protocol_version == 0 {
            return Err("protocolVersion must be at least 1".to_owned());
        }
        if self.journal_schema_version == 0 {
            return Err("journalSchemaVersion must be at least 1".to_owned());
        }
        let mut seen = std::collections::BTreeSet::new();
        for capability in &self.capabilities {
            if !valid_capability(capability) {
                return Err(format!(
                    "capability `{capability}` must match ^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$ (at most 128 bytes)"
                ));
            }
            if !seen.insert(capability.as_str()) {
                return Err(format!("capability `{capability}` is listed twice"));
            }
        }
        Ok(())
    }
}

/// Lowercase dot-separated tokens, at most 128 bytes.
fn valid_capability(name: &str) -> bool {
    name.len() <= 128
        && !name.is_empty()
        && name.split('.').all(|token| {
            let mut chars = token.chars();
            chars.next().is_some_and(|first| first.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(capabilities: &[&str]) -> HelloInfo {
        HelloInfo {
            protocol_version: 1,
            journal_schema_version: 1,
            capabilities: capabilities.iter().map(ToString::to_string).collect(),
            package: PackageInfo {
                name: "aizu".to_owned(),
                version: "0.1.0".to_owned(),
            },
        }
    }

    #[test]
    fn versions_start_at_one_and_capabilities_are_wellformed_and_unique() {
        assert!(
            hello(&[CAPABILITY_WORKFLOW_SIGNAL_SUBMIT])
                .validate()
                .is_ok()
        );
        // A newer binary may advertise more capabilities; decoding stays open.
        assert!(
            hello(&[CAPABILITY_WORKFLOW_SIGNAL_SUBMIT, "workflow.status.read"])
                .validate()
                .is_ok()
        );

        let mut zero = hello(&[]);
        zero.protocol_version = 0;
        assert!(zero.validate().is_err());
        let mut zero = hello(&[]);
        zero.journal_schema_version = 0;
        assert!(zero.validate().is_err());

        for bad in ["Workflow.Signal", "workflow..submit", "", "1abc", "a b"] {
            assert!(hello(&[bad]).validate().is_err(), "{bad:?}");
        }
        let long = format!("w{}", "a".repeat(128));
        assert!(hello(&[&long]).validate().is_err());
        assert!(
            hello(&[
                CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
                CAPABILITY_WORKFLOW_SIGNAL_SUBMIT
            ])
            .validate()
            .is_err()
        );
    }
}
