//! Structured workflow signals and the assignment they are expected to match.

use crate::identity::{
    ArtifactRef, ArtifactRevision, AssignmentId, AttemptId, Digest, EventId, ShortErrorCode,
    WorkflowId,
};
use crate::workflow::error::{InvalidSignal, WorkflowError};

/// The role an assignment was given to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Role {
    /// Produces or repairs a candidate revision.
    Implementation,
    /// Reviews a candidate revision independently.
    Review,
}

/// What a signal claims about the assignment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SignalKind {
    /// Implementation submitted a candidate revision.
    ImplementationReady,
    /// Review found one or more findings.
    ReviewFindings,
    /// Review found no findings. This alone never integrates anything
    /// (hard invariant 6).
    ReviewPassed,
    /// Implementation submitted a repair for earlier findings.
    RepairSubmitted,
    /// The role cannot continue; `short_error_code` says why.
    Blocked,
}

impl SignalKind {
    /// The role allowed to emit this kind, or `None` if any role may.
    #[must_use]
    pub const fn required_role(self) -> Option<Role> {
        match self {
            Self::ImplementationReady | Self::RepairSubmitted => Some(Role::Implementation),
            Self::ReviewFindings | Self::ReviewPassed => Some(Role::Review),
            Self::Blocked => None,
        }
    }
}

/// The assignment a shell is bound to. Every signal must match it exactly.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ExpectedAssignment {
    /// Workflow the assignment belongs to.
    pub workflow_id: WorkflowId,
    /// The assignment itself.
    pub assignment_id: AssignmentId,
    /// Execution attempt the assignment is bound to.
    pub attempt_id: AttemptId,
    /// Role the assignment was given to.
    pub role: Role,
    /// Candidate revision the assignment is bound to.
    pub artifact_revision: ArtifactRevision,
    /// Immutable content of the candidate revision.
    pub candidate_digest: Digest,
    /// Findings event this assignment repairs, when it is a repair attempt.
    pub source_event_id: Option<EventId>,
}

/// Unvalidated parts of a [`WorkflowSignal`]. Validate with
/// [`WorkflowSignal::validate`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignalParts {
    /// Identity of this signal; the unit of duplicate and conflict detection.
    pub event_id: EventId,
    /// Workflow the signal belongs to.
    pub workflow_id: WorkflowId,
    /// Assignment the signal reports on.
    pub assignment_id: AssignmentId,
    /// Execution attempt that produced the signal.
    pub attempt_id: AttemptId,
    /// Role that emitted the signal.
    pub role: Role,
    /// Candidate revision the signal binds to (hard invariant 5).
    pub artifact_revision: ArtifactRevision,
    /// Immutable content of the candidate revision (hard invariant 5).
    pub candidate_digest: Digest,
    /// What the signal claims.
    pub kind: SignalKind,
    /// Number of findings; required for review and repair kinds only.
    pub finding_count: Option<u32>,
    /// Reference to a findings or repair artifact; allowed for
    /// `ReviewFindings`, required for `RepairSubmitted`.
    pub artifact_ref: Option<ArtifactRef>,
    /// Content digest paired with `artifact_ref`; it is present exactly when
    /// the reference is present.
    pub evidence_digest: Option<Digest>,
    /// Review-findings event that caused a repair. Required for
    /// `RepairSubmitted`, allowed for a blocked repair attempt, and forbidden
    /// for other terminal evidence.
    pub source_event_id: Option<EventId>,
    /// Why the role is blocked; required for `Blocked` only.
    pub short_error_code: Option<ShortErrorCode>,
}

/// A validated, structured signal. Construct through
/// [`WorkflowSignal::validate`]; the fields are read through accessors so
/// the kind-specific invariants cannot be broken after construction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowSignal {
    parts: SignalParts,
}

impl WorkflowSignal {
    /// Checks the kind-specific invariants and wraps the parts.
    ///
    /// - the kind must be allowed for the role;
    /// - `finding_count` is required for `ReviewFindings` (> 0),
    ///   `ReviewPassed` (== 0), and `RepairSubmitted` (> 0), and forbidden
    ///   otherwise;
    /// - `artifact_ref` and `evidence_digest` are an inseparable pair,
    ///   optional for `ReviewFindings`, required for `RepairSubmitted`, and
    ///   forbidden otherwise;
    /// - `source_event_id` is required for `RepairSubmitted`, optional for
    ///   `Blocked`, and forbidden otherwise;
    /// - `short_error_code` is required for `Blocked` and forbidden otherwise.
    pub fn validate(parts: SignalParts) -> Result<Self, WorkflowError> {
        let kind = parts.kind;
        if let Some(required) = kind.required_role()
            && required != parts.role
        {
            return Err(InvalidSignal::KindRequiresRole {
                kind,
                role: required,
            }
            .into());
        }

        match (kind, parts.finding_count) {
            (SignalKind::ReviewFindings | SignalKind::RepairSubmitted, Some(0)) => {
                return Err(InvalidSignal::FindingCountMustBePositive { kind }.into());
            }
            (SignalKind::ReviewPassed, Some(count)) if count != 0 => {
                return Err(InvalidSignal::FindingCountMustBeZero.into());
            }
            (
                SignalKind::ReviewFindings | SignalKind::ReviewPassed | SignalKind::RepairSubmitted,
                None,
            ) => {
                return Err(InvalidSignal::FindingCountRequired { kind }.into());
            }
            (SignalKind::ImplementationReady | SignalKind::Blocked, Some(_)) => {
                return Err(InvalidSignal::FindingCountForbidden { kind }.into());
            }
            _ => {}
        }

        match (kind, parts.artifact_ref.is_some()) {
            (SignalKind::RepairSubmitted, false) => {
                return Err(InvalidSignal::ArtifactRefRequired { kind }.into());
            }
            (
                SignalKind::ImplementationReady | SignalKind::ReviewPassed | SignalKind::Blocked,
                true,
            ) => {
                return Err(InvalidSignal::ArtifactRefForbidden { kind }.into());
            }
            _ => {}
        }

        match (kind, parts.evidence_digest.is_some()) {
            (SignalKind::RepairSubmitted, false) => {
                return Err(InvalidSignal::EvidenceDigestRequired { kind }.into());
            }
            (
                SignalKind::ImplementationReady | SignalKind::ReviewPassed | SignalKind::Blocked,
                true,
            ) => {
                return Err(InvalidSignal::EvidenceDigestForbidden { kind }.into());
            }
            _ => {}
        }

        match (
            parts.artifact_ref.is_some(),
            parts.evidence_digest.is_some(),
        ) {
            (true, false) => {
                return Err(InvalidSignal::EvidenceDigestRequired { kind }.into());
            }
            (false, true) => {
                return Err(InvalidSignal::ArtifactRefRequired { kind }.into());
            }
            _ => {}
        }

        match (kind, parts.source_event_id.is_some()) {
            (SignalKind::RepairSubmitted, false) => {
                return Err(InvalidSignal::SourceEventRequired.into());
            }
            (
                SignalKind::ImplementationReady
                | SignalKind::ReviewFindings
                | SignalKind::ReviewPassed,
                true,
            ) => {
                return Err(InvalidSignal::SourceEventForbidden { kind }.into());
            }
            _ => {}
        }

        match (kind, parts.short_error_code.is_some()) {
            (SignalKind::Blocked, false) => {
                return Err(InvalidSignal::ShortErrorCodeRequired.into());
            }
            (kind, true) if kind != SignalKind::Blocked => {
                return Err(InvalidSignal::ShortErrorCodeForbidden { kind }.into());
            }
            _ => {}
        }

        Ok(Self { parts })
    }

    /// Identity of this signal.
    #[must_use]
    pub fn event_id(&self) -> &EventId {
        &self.parts.event_id
    }

    /// Workflow the signal belongs to.
    #[must_use]
    pub fn workflow_id(&self) -> &WorkflowId {
        &self.parts.workflow_id
    }

    /// Assignment the signal reports on.
    #[must_use]
    pub fn assignment_id(&self) -> &AssignmentId {
        &self.parts.assignment_id
    }

    /// Execution attempt that produced the signal.
    #[must_use]
    pub fn attempt_id(&self) -> &AttemptId {
        &self.parts.attempt_id
    }

    /// Role that emitted the signal.
    #[must_use]
    pub fn role(&self) -> Role {
        self.parts.role
    }

    /// Candidate revision the signal binds to.
    #[must_use]
    pub fn artifact_revision(&self) -> &ArtifactRevision {
        &self.parts.artifact_revision
    }

    /// Immutable content of the candidate revision.
    #[must_use]
    pub fn candidate_digest(&self) -> &Digest {
        &self.parts.candidate_digest
    }

    /// What the signal claims.
    #[must_use]
    pub fn kind(&self) -> SignalKind {
        self.parts.kind
    }

    /// Number of findings, when the kind carries one.
    #[must_use]
    pub fn finding_count(&self) -> Option<u32> {
        self.parts.finding_count
    }

    /// Artifact reference, when the kind carries one.
    #[must_use]
    pub fn artifact_ref(&self) -> Option<&ArtifactRef> {
        self.parts.artifact_ref.as_ref()
    }

    /// Content digest paired with the external artifact reference.
    #[must_use]
    pub fn evidence_digest(&self) -> Option<&Digest> {
        self.parts.evidence_digest.as_ref()
    }

    /// Findings event that caused this repair assignment, when present.
    #[must_use]
    pub fn source_event_id(&self) -> Option<&EventId> {
        self.parts.source_event_id.as_ref()
    }

    /// Why the role is blocked, for `Blocked` signals.
    #[must_use]
    pub fn short_error_code(&self) -> Option<&ShortErrorCode> {
        self.parts.short_error_code.as_ref()
    }

    /// The validated parts, for callers that need to convert the signal
    /// into another representation.
    #[must_use]
    pub fn parts(&self) -> &SignalParts {
        &self.parts
    }

    /// Compares the signal with the expected assignment, in the documented
    /// order: workflow, assignment, attempt, role, candidate revision
    /// identifier, candidate digest, causation.
    pub(crate) fn check_expected(
        &self,
        expected: &ExpectedAssignment,
    ) -> Result<(), WorkflowError> {
        if self.parts.workflow_id != expected.workflow_id {
            return Err(WorkflowError::WorkflowMismatch {
                expected: expected.workflow_id.clone(),
                actual: self.parts.workflow_id.clone(),
            });
        }
        if self.parts.assignment_id != expected.assignment_id {
            return Err(WorkflowError::AssignmentMismatch {
                expected: expected.assignment_id.clone(),
                actual: self.parts.assignment_id.clone(),
            });
        }
        if self.parts.attempt_id != expected.attempt_id {
            return Err(WorkflowError::AttemptMismatch {
                expected: expected.attempt_id.clone(),
                actual: self.parts.attempt_id.clone(),
            });
        }
        if self.parts.role != expected.role {
            return Err(WorkflowError::RoleMismatch {
                expected: expected.role,
                actual: self.parts.role,
            });
        }
        if self.parts.artifact_revision != expected.artifact_revision {
            return Err(WorkflowError::RevisionMismatch {
                expected: expected.artifact_revision.clone(),
                actual: self.parts.artifact_revision.clone(),
            });
        }
        if self.parts.candidate_digest != expected.candidate_digest {
            return Err(WorkflowError::CandidateDigestMismatch {
                expected: expected.candidate_digest.clone(),
                actual: self.parts.candidate_digest.clone(),
            });
        }
        if self.parts.source_event_id != expected.source_event_id {
            return Err(WorkflowError::CausationMismatch {
                expected: expected.source_event_id.clone(),
                actual: self.parts.source_event_id.clone(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use alloc::string::ToString;

    use super::*;
    use crate::identity::{AttemptId, DigestAlgorithm};
    use crate::workflow::error::InvalidSignal;

    fn digest(byte: char) -> Digest {
        Digest::new(DigestAlgorithm::Sha256, &byte.to_string().repeat(64)).unwrap()
    }

    fn parts(role: Role, kind: SignalKind) -> SignalParts {
        SignalParts {
            event_id: EventId::new("evt-1").unwrap(),
            workflow_id: WorkflowId::new("wf-1").unwrap(),
            assignment_id: AssignmentId::new("as-1").unwrap(),
            attempt_id: AttemptId::new("attempt-1").unwrap(),
            role,
            artifact_revision: ArtifactRevision::new("rev-1").unwrap(),
            candidate_digest: digest('a'),
            kind,
            finding_count: None,
            artifact_ref: None,
            evidence_digest: None,
            source_event_id: None,
            short_error_code: None,
        }
    }

    fn invalid(result: Result<WorkflowSignal, WorkflowError>) -> InvalidSignal {
        match result {
            Err(WorkflowError::InvalidSignal(reason)) => reason,
            other => panic!("expected InvalidSignal, got {other:?}"),
        }
    }

    #[test]
    fn kinds_are_bound_to_roles() {
        assert!(
            WorkflowSignal::validate(parts(Role::Implementation, SignalKind::ImplementationReady))
                .is_ok()
        );
        assert_eq!(
            invalid(WorkflowSignal::validate(parts(
                Role::Review,
                SignalKind::ImplementationReady
            ))),
            InvalidSignal::KindRequiresRole {
                kind: SignalKind::ImplementationReady,
                role: Role::Implementation
            }
        );
        let mut p = parts(Role::Implementation, SignalKind::ReviewPassed);
        p.finding_count = Some(0);
        assert_eq!(
            invalid(WorkflowSignal::validate(p)),
            InvalidSignal::KindRequiresRole {
                kind: SignalKind::ReviewPassed,
                role: Role::Review
            }
        );
        let mut p = parts(Role::Review, SignalKind::RepairSubmitted);
        p.finding_count = Some(1);
        p.artifact_ref = Some(ArtifactRef::new("repair:abc").unwrap());
        p.evidence_digest = Some(digest('b'));
        p.source_event_id = Some(EventId::new("evt-findings").unwrap());
        assert_eq!(
            invalid(WorkflowSignal::validate(p)),
            InvalidSignal::KindRequiresRole {
                kind: SignalKind::RepairSubmitted,
                role: Role::Implementation
            }
        );
    }

    #[test]
    fn blocked_is_allowed_for_any_role_but_needs_a_code() {
        for role in [Role::Implementation, Role::Review] {
            let mut p = parts(role, SignalKind::Blocked);
            assert_eq!(
                invalid(WorkflowSignal::validate(p.clone())),
                InvalidSignal::ShortErrorCodeRequired
            );
            p.short_error_code = Some(ShortErrorCode::new("NO_ACCESS").unwrap());
            assert!(WorkflowSignal::validate(p).is_ok());
        }
    }

    #[test]
    fn finding_count_rules() {
        let mut p = parts(Role::Review, SignalKind::ReviewFindings);
        assert_eq!(
            invalid(WorkflowSignal::validate(p.clone())),
            InvalidSignal::FindingCountRequired {
                kind: SignalKind::ReviewFindings
            }
        );
        p.finding_count = Some(0);
        assert_eq!(
            invalid(WorkflowSignal::validate(p.clone())),
            InvalidSignal::FindingCountMustBePositive {
                kind: SignalKind::ReviewFindings
            }
        );
        p.finding_count = Some(3);
        assert!(WorkflowSignal::validate(p).is_ok());

        let mut p = parts(Role::Review, SignalKind::ReviewPassed);
        p.finding_count = Some(2);
        assert_eq!(
            invalid(WorkflowSignal::validate(p.clone())),
            InvalidSignal::FindingCountMustBeZero
        );
        p.finding_count = Some(0);
        assert!(WorkflowSignal::validate(p).is_ok());

        let mut p = parts(Role::Implementation, SignalKind::ImplementationReady);
        p.finding_count = Some(0);
        assert_eq!(
            invalid(WorkflowSignal::validate(p)),
            InvalidSignal::FindingCountForbidden {
                kind: SignalKind::ImplementationReady
            }
        );
    }

    #[test]
    fn artifact_ref_rules() {
        let mut p = parts(Role::Implementation, SignalKind::RepairSubmitted);
        p.finding_count = Some(1);
        assert_eq!(
            invalid(WorkflowSignal::validate(p.clone())),
            InvalidSignal::ArtifactRefRequired {
                kind: SignalKind::RepairSubmitted
            }
        );
        p.artifact_ref = Some(ArtifactRef::new("repair:abc").unwrap());
        p.evidence_digest = Some(digest('b'));
        p.source_event_id = Some(EventId::new("evt-findings").unwrap());
        assert!(WorkflowSignal::validate(p).is_ok());

        let mut p = parts(Role::Review, SignalKind::ReviewFindings);
        p.finding_count = Some(1);
        assert!(
            WorkflowSignal::validate(p.clone()).is_ok(),
            "artifact_ref is optional for findings"
        );
        p.artifact_ref = Some(ArtifactRef::new("review:abc").unwrap());
        p.evidence_digest = Some(digest('c'));
        assert!(WorkflowSignal::validate(p).is_ok());

        let mut p = parts(Role::Implementation, SignalKind::ImplementationReady);
        p.artifact_ref = Some(ArtifactRef::new("x").unwrap());
        assert_eq!(
            invalid(WorkflowSignal::validate(p)),
            InvalidSignal::ArtifactRefForbidden {
                kind: SignalKind::ImplementationReady
            }
        );
    }

    #[test]
    fn artifact_references_and_evidence_digests_are_an_inseparable_pair() {
        let mut p = parts(Role::Review, SignalKind::ReviewFindings);
        p.finding_count = Some(1);
        p.artifact_ref = Some(ArtifactRef::new("review:abc").unwrap());
        assert_eq!(
            invalid(WorkflowSignal::validate(p.clone())),
            InvalidSignal::EvidenceDigestRequired {
                kind: SignalKind::ReviewFindings
            }
        );
        p.artifact_ref = None;
        p.evidence_digest = Some(digest('d'));
        assert_eq!(
            invalid(WorkflowSignal::validate(p)),
            InvalidSignal::ArtifactRefRequired {
                kind: SignalKind::ReviewFindings
            }
        );
    }

    #[test]
    fn repair_requires_a_source_event_and_other_terminal_evidence_forbids_it() {
        let mut repair = parts(Role::Implementation, SignalKind::RepairSubmitted);
        repair.finding_count = Some(1);
        repair.artifact_ref = Some(ArtifactRef::new("repair:abc").unwrap());
        repair.evidence_digest = Some(digest('e'));
        assert_eq!(
            invalid(WorkflowSignal::validate(repair.clone())),
            InvalidSignal::SourceEventRequired
        );
        repair.source_event_id = Some(EventId::new("evt-findings").unwrap());
        assert!(WorkflowSignal::validate(repair).is_ok());

        let mut ready = parts(Role::Implementation, SignalKind::ImplementationReady);
        ready.source_event_id = Some(EventId::new("evt-findings").unwrap());
        assert_eq!(
            invalid(WorkflowSignal::validate(ready)),
            InvalidSignal::SourceEventForbidden {
                kind: SignalKind::ImplementationReady
            }
        );
    }

    #[test]
    fn short_error_code_is_only_for_blocked() {
        let mut p = parts(Role::Implementation, SignalKind::ImplementationReady);
        p.short_error_code = Some(ShortErrorCode::new("X").unwrap());
        assert_eq!(
            invalid(WorkflowSignal::validate(p)),
            InvalidSignal::ShortErrorCodeForbidden {
                kind: SignalKind::ImplementationReady
            }
        );
    }

    #[test]
    fn accessors_expose_the_validated_parts() {
        let mut p = parts(Role::Review, SignalKind::ReviewFindings);
        p.finding_count = Some(2);
        p.artifact_ref = Some(ArtifactRef::new("review:abc").unwrap());
        p.evidence_digest = Some(digest('f'));
        let signal = WorkflowSignal::validate(p.clone()).unwrap();
        assert_eq!(signal.event_id().as_str(), "evt-1");
        assert_eq!(signal.attempt_id().as_str(), "attempt-1");
        assert_eq!(signal.role(), Role::Review);
        assert_eq!(signal.kind(), SignalKind::ReviewFindings);
        assert_eq!(signal.finding_count(), Some(2));
        assert_eq!(
            signal.artifact_ref().map(ArtifactRef::as_str),
            Some("review:abc")
        );
        assert_eq!(signal.candidate_digest(), &digest('a'));
        assert_eq!(signal.evidence_digest(), Some(&digest('f')));
        assert_eq!(signal.source_event_id(), None);
        assert_eq!(signal.short_error_code(), None);
        assert_eq!(signal.parts(), &p);
    }
}
