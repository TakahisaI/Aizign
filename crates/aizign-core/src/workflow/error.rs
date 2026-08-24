//! Explainable rejections of workflow commands, each with a stable short
//! error code registered in `docs/reference/error-codes.md`.

use core::fmt;

use crate::identity::{ArtifactRevision, AssignmentId, AttemptId, Digest, EventId, WorkflowId};
use crate::workflow::signal::{Role, SignalKind};

/// Why a signal's parts do not form a valid [`WorkflowSignal`].
///
/// [`WorkflowSignal`]: crate::workflow::WorkflowSignal
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InvalidSignal {
    /// The kind may only be emitted by `role`.
    KindRequiresRole {
        /// The offending kind.
        kind: SignalKind,
        /// The role the kind requires.
        role: Role,
    },
    /// The kind carries a finding count but none was given.
    FindingCountRequired {
        /// The kind that requires a count.
        kind: SignalKind,
    },
    /// The kind does not carry a finding count.
    FindingCountForbidden {
        /// The kind that forbids a count.
        kind: SignalKind,
    },
    /// `ReviewFindings` and `RepairSubmitted` need at least one finding.
    FindingCountMustBePositive {
        /// The kind that requires a positive count.
        kind: SignalKind,
    },
    /// `ReviewPassed` means zero findings.
    FindingCountMustBeZero,
    /// The kind requires an artifact reference.
    ArtifactRefRequired {
        /// The kind that requires a reference.
        kind: SignalKind,
    },
    /// The kind does not carry an artifact reference.
    ArtifactRefForbidden {
        /// The kind that forbids a reference.
        kind: SignalKind,
    },
    /// `Blocked` requires a short error code.
    ShortErrorCodeRequired,
    /// Only `Blocked` carries a short error code.
    ShortErrorCodeForbidden {
        /// The kind that forbids a code.
        kind: SignalKind,
    },
}

impl fmt::Display for InvalidSignal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::KindRequiresRole { kind, role } => {
                write!(f, "{kind:?} requires the {role:?} role")
            }
            Self::FindingCountRequired { kind } => write!(f, "{kind:?} requires finding_count"),
            Self::FindingCountForbidden { kind } => {
                write!(f, "{kind:?} does not carry finding_count")
            }
            Self::FindingCountMustBePositive { kind } => {
                write!(f, "{kind:?} requires finding_count greater than zero")
            }
            Self::FindingCountMustBeZero => f.write_str("ReviewPassed requires finding_count zero"),
            Self::ArtifactRefRequired { kind } => write!(f, "{kind:?} requires artifact_ref"),
            Self::ArtifactRefForbidden { kind } => {
                write!(f, "{kind:?} does not carry artifact_ref")
            }
            Self::ShortErrorCodeRequired => f.write_str("Blocked requires short_error_code"),
            Self::ShortErrorCodeForbidden { kind } => {
                write!(f, "{kind:?} does not carry short_error_code")
            }
        }
    }
}

/// An explainable rejection of a workflow command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkflowError {
    /// The signal's parts violate a kind-specific invariant.
    InvalidSignal(InvalidSignal),
    /// The signal belongs to a different workflow than expected.
    WorkflowMismatch {
        /// Expected workflow.
        expected: WorkflowId,
        /// Workflow named by the signal.
        actual: WorkflowId,
    },
    /// The signal reports on a different assignment than expected.
    AssignmentMismatch {
        /// Expected assignment.
        expected: AssignmentId,
        /// Assignment named by the signal.
        actual: AssignmentId,
    },
    /// The signal was produced by a different execution attempt.
    AttemptMismatch {
        /// Expected attempt.
        expected: AttemptId,
        /// Attempt named by the signal.
        actual: AttemptId,
    },
    /// The signal was emitted by a different role than expected.
    RoleMismatch {
        /// Expected role.
        expected: Role,
        /// Role named by the signal.
        actual: Role,
    },
    /// The signal binds to a different candidate revision than expected.
    RevisionMismatch {
        /// Expected revision.
        expected: ArtifactRevision,
        /// Revision named by the signal.
        actual: ArtifactRevision,
    },
    /// The candidate revision identifier matched but its immutable content did not.
    CandidateDigestMismatch {
        /// Expected candidate content.
        expected: Digest,
        /// Candidate content named by the signal.
        actual: Digest,
    },
    /// A signal with the same event id but different content was already
    /// accepted (hard invariant 12).
    EventConflict {
        /// The contested event id.
        event_id: EventId,
    },
}

impl WorkflowError {
    /// The stable short error code for this rejection.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidSignal(_) => "INVALID_SIGNAL",
            Self::WorkflowMismatch { .. } => "WORKFLOW_MISMATCH",
            Self::AssignmentMismatch { .. } => "ASSIGNMENT_MISMATCH",
            Self::AttemptMismatch { .. } => "ATTEMPT_MISMATCH",
            Self::RoleMismatch { .. } => "ROLE_MISMATCH",
            Self::RevisionMismatch { .. } => "REVISION_MISMATCH",
            Self::CandidateDigestMismatch { .. } => "CANDIDATE_DIGEST_MISMATCH",
            Self::EventConflict { .. } => "EVENT_CONFLICT",
        }
    }
}

impl From<InvalidSignal> for WorkflowError {
    fn from(reason: InvalidSignal) -> Self {
        Self::InvalidSignal(reason)
    }
}

impl fmt::Display for WorkflowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSignal(reason) => write!(f, "invalid signal: {reason}"),
            Self::WorkflowMismatch { expected, actual } => {
                write!(f, "workflow mismatch: expected {expected}, got {actual}")
            }
            Self::AssignmentMismatch { expected, actual } => {
                write!(f, "assignment mismatch: expected {expected}, got {actual}")
            }
            Self::AttemptMismatch { expected, actual } => {
                write!(f, "attempt mismatch: expected {expected}, got {actual}")
            }
            Self::RoleMismatch { expected, actual } => {
                write!(f, "role mismatch: expected {expected:?}, got {actual:?}")
            }
            Self::RevisionMismatch { expected, actual } => {
                write!(f, "revision mismatch: expected {expected}, got {actual}")
            }
            Self::CandidateDigestMismatch { expected, actual } => {
                write!(
                    f,
                    "candidate digest mismatch: expected {expected}, got {actual}"
                )
            }
            Self::EventConflict { event_id } => {
                write!(
                    f,
                    "event {event_id} was already accepted with different content"
                )
            }
        }
    }
}

impl core::error::Error for WorkflowError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::ShortErrorCode;

    #[test]
    fn every_code_is_a_valid_short_error_code() {
        let wf = WorkflowId::new("wf").unwrap();
        let asg = AssignmentId::new("as").unwrap();
        let attempt = AttemptId::new("attempt").unwrap();
        let rev = ArtifactRevision::new("rev").unwrap();
        let digest =
            Digest::new(crate::identity::DigestAlgorithm::Sha256, &"a".repeat(64)).unwrap();
        let evt = EventId::new("evt").unwrap();
        let errors = [
            WorkflowError::InvalidSignal(InvalidSignal::ShortErrorCodeRequired),
            WorkflowError::WorkflowMismatch {
                expected: wf.clone(),
                actual: wf,
            },
            WorkflowError::AssignmentMismatch {
                expected: asg.clone(),
                actual: asg,
            },
            WorkflowError::AttemptMismatch {
                expected: attempt.clone(),
                actual: attempt,
            },
            WorkflowError::RoleMismatch {
                expected: Role::Review,
                actual: Role::Implementation,
            },
            WorkflowError::RevisionMismatch {
                expected: rev.clone(),
                actual: rev,
            },
            WorkflowError::CandidateDigestMismatch {
                expected: digest.clone(),
                actual: digest,
            },
            WorkflowError::EventConflict { event_id: evt },
        ];
        for error in errors {
            assert!(
                ShortErrorCode::new(error.code()).is_ok(),
                "{}",
                error.code()
            );
            assert!(!alloc::format!("{error}").is_empty());
        }
    }
}
