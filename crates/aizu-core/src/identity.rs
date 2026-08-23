//! Stable identities, digests, and bounded timestamps: the minimal shared
//! vocabulary every bounded context may use.
//!
//! Every type here is validated on construction, so the rest of the core can
//! treat a value of these types as well-formed. None of them carries
//! harness- or provider-specific meaning (hard invariant 8).

use alloc::string::String;
use core::fmt;

/// Maximum length, in bytes, of a stable identifier.
pub const IDENTIFIER_MAX_LEN: usize = 128;

/// Maximum length, in bytes, of an artifact reference.
pub const ARTIFACT_REF_MAX_LEN: usize = 256;

/// Maximum length, in bytes, of a short error code.
pub const SHORT_ERROR_CODE_MAX_LEN: usize = 64;

/// Why a value was rejected as an identity-vocabulary type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IdentityError {
    /// The value is empty.
    Empty,
    /// The value exceeds the maximum length for its type.
    TooLong {
        /// Maximum allowed length in bytes.
        max: usize,
        /// Actual length in bytes.
        actual: usize,
    },
    /// The byte at `index` is not allowed at that position.
    InvalidCharacter {
        /// Byte offset of the offending character.
        index: usize,
    },
    /// A digest's hexadecimal payload has the wrong length for its algorithm.
    DigestLength {
        /// Expected number of hexadecimal characters.
        expected: usize,
        /// Actual number of characters.
        actual: usize,
    },
    /// A timestamp lies outside the bounded range the core accepts.
    TimestampOutOfRange,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("value must not be empty"),
            Self::TooLong { max, actual } => {
                write!(f, "value is {actual} bytes long; at most {max} allowed")
            }
            Self::InvalidCharacter { index } => {
                write!(f, "character at byte {index} is not allowed")
            }
            Self::DigestLength { expected, actual } => {
                write!(
                    f,
                    "digest has {actual} hexadecimal characters; expected {expected}"
                )
            }
            Self::TimestampOutOfRange => f.write_str("timestamp is outside the bounded range"),
        }
    }
}

impl core::error::Error for IdentityError {}

/// Validates `^[A-Za-z0-9][A-Za-z0-9._:-]*$` up to `max` bytes.
fn validate_identifier(value: &str, max: usize) -> Result<(), IdentityError> {
    if value.is_empty() {
        return Err(IdentityError::Empty);
    }
    if value.len() > max {
        return Err(IdentityError::TooLong {
            max,
            actual: value.len(),
        });
    }
    for (index, byte) in value.bytes().enumerate() {
        let allowed = byte.is_ascii_alphanumeric()
            || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'));
        if !allowed {
            return Err(IdentityError::InvalidCharacter { index });
        }
    }
    Ok(())
}

macro_rules! identifier_type {
    ($(#[$meta:meta])* $name:ident, $max:expr) => {
        $(#[$meta])*
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            /// Validates and wraps the value.
            pub fn new(value: &str) -> Result<Self, IdentityError> {
                validate_identifier(value, $max)?;
                Ok(Self(String::from(value)))
            }

            /// The validated string.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}

identifier_type!(
    /// Identifies one software change as a whole.
    WorkflowId,
    IDENTIFIER_MAX_LEN
);
identifier_type!(
    /// Identifies one unit of work assigned to a role within a workflow.
    AssignmentId,
    IDENTIFIER_MAX_LEN
);
identifier_type!(
    /// Identifies one execution of an assignment on a harness.
    AttemptId,
    IDENTIFIER_MAX_LEN
);
identifier_type!(
    /// Identifies the candidate revision that evidence binds to.
    ArtifactRevision,
    IDENTIFIER_MAX_LEN
);
identifier_type!(
    /// Identifies one domain event; the unit of duplicate and conflict detection.
    EventId,
    IDENTIFIER_MAX_LEN
);
identifier_type!(
    /// An opaque, bounded reference to an artifact stored outside the journal.
    ///
    /// The core only compares and stores it; interpreting the reference is
    /// the job of the context that issued it.
    ArtifactRef,
    ARTIFACT_REF_MAX_LEN
);

/// A stable, machine-readable error code: `^[A-Z][A-Z0-9_]{0,63}$`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ShortErrorCode(String);

impl ShortErrorCode {
    /// Validates and wraps the value.
    pub fn new(value: &str) -> Result<Self, IdentityError> {
        if value.is_empty() {
            return Err(IdentityError::Empty);
        }
        if value.len() > SHORT_ERROR_CODE_MAX_LEN {
            return Err(IdentityError::TooLong {
                max: SHORT_ERROR_CODE_MAX_LEN,
                actual: value.len(),
            });
        }
        for (index, byte) in value.bytes().enumerate() {
            let allowed =
                byte.is_ascii_uppercase() || (index > 0 && (byte.is_ascii_digit() || byte == b'_'));
            if !allowed {
                return Err(IdentityError::InvalidCharacter { index });
            }
        }
        Ok(Self(String::from(value)))
    }

    /// The validated code.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ShortErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Hash algorithms the core recognizes. The core never computes a digest;
/// it only carries and compares them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DigestAlgorithm {
    /// SHA-256, rendered as 64 lowercase hexadecimal characters.
    Sha256,
}

impl DigestAlgorithm {
    /// Number of hexadecimal characters a digest of this algorithm has.
    #[must_use]
    pub const fn hex_len(self) -> usize {
        match self {
            Self::Sha256 => 64,
        }
    }
}

/// A content digest: algorithm plus lowercase hexadecimal payload.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Digest {
    algorithm: DigestAlgorithm,
    hex: String,
}

impl Digest {
    /// Validates the hexadecimal payload against the algorithm's length.
    pub fn new(algorithm: DigestAlgorithm, hex: &str) -> Result<Self, IdentityError> {
        let expected = algorithm.hex_len();
        if hex.len() != expected {
            return Err(IdentityError::DigestLength {
                expected,
                actual: hex.len(),
            });
        }
        for (index, byte) in hex.bytes().enumerate() {
            if !(byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
                return Err(IdentityError::InvalidCharacter { index });
            }
        }
        Ok(Self {
            algorithm,
            hex: String::from(hex),
        })
    }

    /// The algorithm that produced this digest.
    #[must_use]
    pub const fn algorithm(&self) -> DigestAlgorithm {
        self.algorithm
    }

    /// The lowercase hexadecimal payload.
    #[must_use]
    pub fn hex(&self) -> &str {
        &self.hex
    }
}

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.algorithm {
            DigestAlgorithm::Sha256 => write!(f, "sha256:{}", self.hex),
        }
    }
}

/// Seconds since the Unix epoch, supplied by the shell and bounded so that
/// nonsensical values cannot enter the journal. The core never reads a clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BoundedTimestamp(u64);

impl BoundedTimestamp {
    /// Earliest accepted value: 2020-01-01T00:00:00Z.
    pub const MIN_UNIX_SECONDS: u64 = 1_577_836_800;
    /// Latest accepted value: 2100-01-01T00:00:00Z.
    pub const MAX_UNIX_SECONDS: u64 = 4_102_444_800;

    /// Accepts a Unix timestamp inside the bounded range.
    pub fn from_unix_seconds(seconds: u64) -> Result<Self, IdentityError> {
        if (Self::MIN_UNIX_SECONDS..=Self::MAX_UNIX_SECONDS).contains(&seconds) {
            Ok(Self(seconds))
        } else {
            Err(IdentityError::TimestampOutOfRange)
        }
    }

    /// Seconds since the Unix epoch.
    #[must_use]
    pub const fn unix_seconds(self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_accept_the_documented_alphabet() {
        for value in ["a", "A1", "wf-01", "run.2026_08:23", "x-"] {
            assert!(WorkflowId::new(value).is_ok(), "{value}");
        }
    }

    #[test]
    fn identifiers_reject_bad_first_characters_and_alphabet() {
        assert_eq!(WorkflowId::new(""), Err(IdentityError::Empty));
        assert_eq!(
            WorkflowId::new("-leading"),
            Err(IdentityError::InvalidCharacter { index: 0 })
        );
        assert_eq!(
            WorkflowId::new("has space"),
            Err(IdentityError::InvalidCharacter { index: 3 })
        );
        assert_eq!(
            WorkflowId::new("non-ascii-é"),
            Err(IdentityError::InvalidCharacter { index: 10 })
        );
    }

    #[test]
    fn identifiers_are_length_bounded() {
        let max = "a".repeat(IDENTIFIER_MAX_LEN);
        assert!(EventId::new(&max).is_ok());
        let over = "a".repeat(IDENTIFIER_MAX_LEN + 1);
        assert_eq!(
            EventId::new(&over),
            Err(IdentityError::TooLong {
                max: IDENTIFIER_MAX_LEN,
                actual: IDENTIFIER_MAX_LEN + 1
            })
        );
        let long_ref = "r".repeat(ARTIFACT_REF_MAX_LEN);
        assert!(ArtifactRef::new(&long_ref).is_ok());
    }

    #[test]
    fn short_error_codes_follow_the_pattern() {
        assert!(ShortErrorCode::new("BLOCKED_BY_POLICY_2").is_ok());
        assert_eq!(
            ShortErrorCode::new("lower"),
            Err(IdentityError::InvalidCharacter { index: 0 })
        );
        assert_eq!(
            ShortErrorCode::new("_LEADING"),
            Err(IdentityError::InvalidCharacter { index: 0 })
        );
        assert_eq!(
            ShortErrorCode::new("1DIGIT"),
            Err(IdentityError::InvalidCharacter { index: 0 })
        );
        assert_eq!(ShortErrorCode::new(""), Err(IdentityError::Empty));
        let over = "A".repeat(SHORT_ERROR_CODE_MAX_LEN + 1);
        assert!(matches!(
            ShortErrorCode::new(&over),
            Err(IdentityError::TooLong { .. })
        ));
    }

    #[test]
    fn digests_require_the_exact_lowercase_hex_length() {
        let hex = "0".repeat(64);
        let digest = Digest::new(DigestAlgorithm::Sha256, &hex).expect("valid digest");
        assert_eq!(digest.algorithm(), DigestAlgorithm::Sha256);
        assert_eq!(alloc::format!("{digest}"), alloc::format!("sha256:{hex}"));

        assert_eq!(
            Digest::new(DigestAlgorithm::Sha256, "abc"),
            Err(IdentityError::DigestLength {
                expected: 64,
                actual: 3
            })
        );
        let upper = "A".repeat(64);
        assert_eq!(
            Digest::new(DigestAlgorithm::Sha256, &upper),
            Err(IdentityError::InvalidCharacter { index: 0 })
        );
    }

    #[test]
    fn timestamps_are_bounded() {
        assert!(BoundedTimestamp::from_unix_seconds(1_724_400_000).is_ok());
        assert_eq!(
            BoundedTimestamp::from_unix_seconds(0),
            Err(IdentityError::TimestampOutOfRange)
        );
        assert_eq!(
            BoundedTimestamp::from_unix_seconds(u64::MAX),
            Err(IdentityError::TimestampOutOfRange)
        );
    }
}
