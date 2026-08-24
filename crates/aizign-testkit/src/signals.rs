//! Ready-made, valid workflow signals for tests.

use aizign_core::workflow::{ExpectedAssignment, Role, SignalKind, SignalParts, WorkflowSignal};
use aizign_core::{
    ArtifactRevision, AssignmentId, AttemptId, BoundedTimestamp, Digest, DigestAlgorithm, EventId,
    ShortErrorCode, WorkflowId,
};

/// A deterministic SHA-256 digest for fixture content.
#[must_use]
pub fn digest(byte: char) -> Digest {
    Digest::new(DigestAlgorithm::Sha256, &byte.to_string().repeat(64)).expect("valid")
}

/// The assignment every helper in this module binds to.
#[must_use]
pub fn expected() -> ExpectedAssignment {
    ExpectedAssignment {
        workflow_id: WorkflowId::new("wf-test").expect("valid"),
        assignment_id: AssignmentId::new("as-implementation").expect("valid"),
        attempt_id: AttemptId::new("attempt-implementation").expect("valid"),
        role: Role::Implementation,
        artifact_revision: ArtifactRevision::new("rev-a").expect("valid"),
        candidate_digest: digest('a'),
    }
}

/// An `implementation_ready` signal for [`expected`] with the given event id.
#[must_use]
pub fn implementation_ready(event_id: &str) -> WorkflowSignal {
    let expected = expected();
    WorkflowSignal::validate(SignalParts {
        event_id: EventId::new(event_id).expect("valid"),
        workflow_id: expected.workflow_id,
        assignment_id: expected.assignment_id,
        attempt_id: expected.attempt_id,
        role: expected.role,
        artifact_revision: expected.artifact_revision,
        candidate_digest: expected.candidate_digest,
        kind: SignalKind::ImplementationReady,
        finding_count: None,
        artifact_ref: None,
        short_error_code: None,
    })
    .expect("valid")
}

/// A `blocked` signal for [`expected`] with the given event id and code.
#[must_use]
pub fn blocked(event_id: &str, code: &str) -> WorkflowSignal {
    let mut parts = implementation_ready(event_id).parts().clone();
    parts.kind = SignalKind::Blocked;
    parts.short_error_code = Some(ShortErrorCode::new(code).expect("valid"));
    WorkflowSignal::validate(parts).expect("valid")
}

/// A fixed, in-range timestamp.
#[must_use]
pub fn at(offset: u64) -> BoundedTimestamp {
    BoundedTimestamp::from_unix_seconds(1_724_400_000 + offset).expect("in range")
}
