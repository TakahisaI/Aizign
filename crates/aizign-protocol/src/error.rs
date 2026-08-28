//! Protocol-level errors and the stable short codes they carry.

use core::fmt;

use aizign_core::ShortErrorCode;
use aizign_core::workflow::WorkflowError;

/// Stable short error codes emitted at the protocol boundary. Workflow
/// rejections reuse `aizign_core::workflow::WorkflowError::code`.
pub mod codes {
    /// The envelope `version` is not one this implementation speaks.
    pub const PROTOCOL_VERSION_UNSUPPORTED: &str = "PROTOCOL_VERSION_UNSUPPORTED";
    /// The envelope is not a closed, well-formed `aizign` envelope.
    pub const INVALID_ENVELOPE: &str = "INVALID_ENVELOPE";
    /// The `kind` is not registered.
    pub const UNKNOWN_KIND: &str = "UNKNOWN_KIND";
    /// The payload does not match the kind's closed schema.
    pub const INVALID_PAYLOAD: &str = "INVALID_PAYLOAD";
    /// The request exceeds the size bound.
    pub const REQUEST_TOO_LARGE: &str = "REQUEST_TOO_LARGE";
    /// The binary decoded a Protocol-registered operation request under an
    /// accepted operation version, but this binary, build, or target does not
    /// provide that operation.
    pub const CAPABILITY_UNSUPPORTED: &str = "CAPABILITY_UNSUPPORTED";
    /// An unclassified failure; details go to stderr, never to the wire.
    pub const INTERNAL: &str = "INTERNAL";
    /// Processing exceeded the time bound. Any append in flight has an
    /// unknown outcome; the caller must reconcile, not retry.
    pub const HANDLER_TIMEOUT: &str = "HANDLER_TIMEOUT";
    /// The expected assignment has a well-formed shape but invalid values.
    pub const INVALID_EXPECTATION: &str = "INVALID_EXPECTATION";
}

/// The exact fixed wire codes implemented by the current operation set.
///
/// Protocol decoding remains open to every well-formed short code. This list
/// records current membership only; it does not assign operation-specific
/// outcome semantics.
pub const CURRENT_FIXED_ERROR_CODES: &[&str] = &[
    codes::PROTOCOL_VERSION_UNSUPPORTED,
    codes::INVALID_ENVELOPE,
    codes::UNKNOWN_KIND,
    codes::INVALID_PAYLOAD,
    codes::REQUEST_TOO_LARGE,
    codes::CAPABILITY_UNSUPPORTED,
    codes::INVALID_EXPECTATION,
    "INVALID_SIGNAL",
    "WORKFLOW_MISMATCH",
    "ASSIGNMENT_MISMATCH",
    "ATTEMPT_MISMATCH",
    "ROLE_MISMATCH",
    "REVISION_MISMATCH",
    "CANDIDATE_DIGEST_MISMATCH",
    "EVENT_CONFLICT",
    "JOURNAL_UNAVAILABLE",
    "JOURNAL_CORRUPT",
    "JOURNAL_SCHEMA_UNSUPPORTED",
    "JOURNAL_LOCKED",
    "JOURNAL_BOUND_EXCEEDED",
    codes::INTERNAL,
    codes::HANDLER_TIMEOUT,
    "JOURNAL_OUTCOME_UNKNOWN",
];

/// Whether `code` is one of the current fixed wire codes.
///
/// A `false` result does not make a well-formed peer code invalid. Consumers
/// must fail closed instead of deriving rejection, success, or retry authority.
#[must_use]
pub fn is_current_fixed_error_code(code: &str) -> bool {
    CURRENT_FIXED_ERROR_CODES.contains(&code)
}

/// A protocol-boundary error carrying a stable code and an operational
/// diagnostic. It may represent a decoded wire error, a local
/// encode/validation failure, or a workflow rejection. The message is not a
/// model-safe field and may contain state-path or operating-system detail;
/// adapters must normalize it before a model-facing boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError {
    code: ShortErrorCode,
    message: String,
}

impl ProtocolError {
    /// Tries to build an error from a raw short code.
    ///
    /// The constants in [`codes`] and `WorkflowError::code` are registered,
    /// but a decoded peer may supply another syntactically valid code whose
    /// operation semantics the consuming client does not recognize. Malformed
    /// input is returned to the caller and is never normalized.
    pub fn try_new(
        code: &str,
        message: impl Into<String>,
    ) -> Result<Self, aizign_core::IdentityError> {
        Ok(Self {
            code: ShortErrorCode::new(code)?,
            message: message.into(),
        })
    }

    pub(crate) fn from_valid_code(code: &str, message: impl Into<String>) -> Self {
        Self::try_new(code, message).expect("Protocol owner supplied a well-formed code")
    }

    /// The stable code.
    #[must_use]
    pub fn code(&self) -> &ShortErrorCode {
        &self.code
    }

    /// The message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl From<WorkflowError> for ProtocolError {
    fn from(error: WorkflowError) -> Self {
        Self::from_valid_code(error.code(), error.to_string())
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProtocolError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_codes_are_valid_short_codes() {
        for &code in CURRENT_FIXED_ERROR_CODES {
            assert_eq!(
                ProtocolError::try_new(code, "m").unwrap().code().as_str(),
                code
            );
        }
    }

    #[test]
    fn fixed_membership_is_exactly_the_classification_corpus_projection() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../spec/classification/current-operations.json"
        ))
        .expect("classification corpus");
        let corpus_codes = corpus["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .filter_map(|row| {
                (row["reportedCode"]["kind"] == "fixed")
                    .then(|| row["reportedCode"]["value"].as_str())
                    .flatten()
            })
            .collect::<std::collections::BTreeSet<_>>();
        let registered = CURRENT_FIXED_ERROR_CODES
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(corpus_codes, registered);
        assert!(!is_current_fixed_error_code("FUTURE_OUTCOME_UNKNOWN"));
        assert!(!is_current_fixed_error_code("EFFECT_OUTCOME_UNKNOWN"));
    }

    #[test]
    fn malformed_codes_are_rejected_without_normalization() {
        assert!(ProtocolError::try_new("not a code", "m").is_err());
        assert_eq!(
            ProtocolError::try_new("FUTURE_OUTCOME_UNKNOWN", "m")
                .unwrap()
                .code()
                .as_str(),
            "FUTURE_OUTCOME_UNKNOWN"
        );
    }
}
