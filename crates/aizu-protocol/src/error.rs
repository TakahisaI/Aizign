//! Protocol-level errors and the stable short codes they carry.

use core::fmt;

use aizu_core::ShortErrorCode;
use aizu_core::workflow::WorkflowError;

/// Stable short error codes emitted at the protocol boundary. Workflow
/// rejections reuse `aizu_core::workflow::WorkflowError::code`.
pub mod codes {
    /// The envelope `version` is not one this implementation speaks.
    pub const PROTOCOL_VERSION_UNSUPPORTED: &str = "PROTOCOL_VERSION_UNSUPPORTED";
    /// The envelope is not a closed, well-formed `aizu` envelope.
    pub const INVALID_ENVELOPE: &str = "INVALID_ENVELOPE";
    /// The `kind` is not registered.
    pub const UNKNOWN_KIND: &str = "UNKNOWN_KIND";
    /// The payload does not match the kind's closed schema.
    pub const INVALID_PAYLOAD: &str = "INVALID_PAYLOAD";
    /// The request exceeds the size bound.
    pub const REQUEST_TOO_LARGE: &str = "REQUEST_TOO_LARGE";
    /// The kind is known but not enabled by this binary or adapter.
    pub const CAPABILITY_UNSUPPORTED: &str = "CAPABILITY_UNSUPPORTED";
    /// An unclassified failure; details go to stderr, never to the wire.
    pub const INTERNAL: &str = "INTERNAL";
    /// Processing exceeded the time bound. Any append in flight has an
    /// unknown outcome; the caller must reconcile, not retry.
    pub const HANDLER_TIMEOUT: &str = "HANDLER_TIMEOUT";
    /// The expected assignment has a well-formed shape but invalid values.
    pub const INVALID_EXPECTATION: &str = "INVALID_EXPECTATION";
}

/// A response-level error: a stable code plus a human-readable message that
/// never contains request content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError {
    code: ShortErrorCode,
    message: String,
}

impl ProtocolError {
    /// Builds an error from one of the registered codes.
    ///
    /// `code` must satisfy the short-error-code pattern; the constants in
    /// [`codes`] and `WorkflowError::code` do. Anything else degrades to
    /// [`codes::INTERNAL`] so a malformed code can never reach the wire.
    #[must_use]
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        let code = ShortErrorCode::new(code)
            .unwrap_or_else(|_| ShortErrorCode::new(codes::INTERNAL).expect("constant code"));
        Self {
            code,
            message: message.into(),
        }
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
        Self::new(error.code(), error.to_string())
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
        for code in [
            codes::PROTOCOL_VERSION_UNSUPPORTED,
            codes::INVALID_ENVELOPE,
            codes::UNKNOWN_KIND,
            codes::INVALID_PAYLOAD,
            codes::REQUEST_TOO_LARGE,
            codes::CAPABILITY_UNSUPPORTED,
            codes::INTERNAL,
            codes::HANDLER_TIMEOUT,
            codes::INVALID_EXPECTATION,
        ] {
            assert_eq!(ProtocolError::new(code, "m").code().as_str(), code);
        }
    }

    #[test]
    fn malformed_codes_degrade_to_internal() {
        assert_eq!(
            ProtocolError::new("not a code", "m").code().as_str(),
            codes::INTERNAL
        );
    }
}
