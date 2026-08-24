//! Pure reconciliation of a signal against replayed workflow state.

use aizign_core::recovery::{SignalReconciliation, reconcile_workflow_signal};
use aizign_core::workflow::{SignalKind, WorkflowEvent, WorkflowSignal, WorkflowState};
use aizign_core::{AttemptId, Digest, DigestAlgorithm, EventId, ShortErrorCode};

fn signal_parts(event_id: &str) -> aizign_core::workflow::SignalParts {
    use aizign_core::workflow::{Role, SignalParts};
    use aizign_core::{
        ArtifactRevision, AssignmentId, AttemptId, Digest, DigestAlgorithm, WorkflowId,
    };

    SignalParts {
        event_id: EventId::new(event_id).expect("valid event id"),
        workflow_id: WorkflowId::new("wf-1").expect("valid workflow id"),
        assignment_id: AssignmentId::new("as-1").expect("valid assignment id"),
        attempt_id: AttemptId::new("attempt-1").expect("valid attempt id"),
        role: Role::Implementation,
        artifact_revision: ArtifactRevision::new("rev-1").expect("valid revision"),
        candidate_digest: Digest::new(DigestAlgorithm::Sha256, &"a".repeat(64))
            .expect("valid digest"),
        kind: SignalKind::ImplementationReady,
        finding_count: None,
        artifact_ref: None,
        short_error_code: None,
    }
}

fn ready(event_id: &str) -> WorkflowSignal {
    WorkflowSignal::validate(signal_parts(event_id)).expect("valid signal")
}

fn state_with(signal: WorkflowSignal) -> WorkflowState {
    WorkflowState::replay([&WorkflowEvent::SignalAccepted { signal }]).expect("valid replay")
}

#[test]
fn exact_signal_is_accepted() {
    let signal = ready("evt-1");
    let state = state_with(signal.clone());
    assert_eq!(
        reconcile_workflow_signal(&state, &signal),
        SignalReconciliation::Accepted
    );
}

#[test]
fn same_event_with_any_different_content_is_a_conflict() {
    let state = state_with(ready("evt-1"));
    let mut changed = signal_parts("evt-1");
    changed.kind = SignalKind::Blocked;
    changed.short_error_code = Some(ShortErrorCode::new("STOPPED").expect("valid code"));
    let changed = WorkflowSignal::validate(changed).expect("valid signal");

    assert_eq!(
        reconcile_workflow_signal(&state, &changed),
        SignalReconciliation::Conflict
    );
}

#[test]
fn attempt_and_candidate_content_are_part_of_the_exact_comparison() {
    let state = state_with(ready("evt-1"));

    let mut changed_attempt = signal_parts("evt-1");
    changed_attempt.attempt_id = AttemptId::new("attempt-2").expect("valid attempt");
    assert_eq!(
        reconcile_workflow_signal(
            &state,
            &WorkflowSignal::validate(changed_attempt).expect("valid signal")
        ),
        SignalReconciliation::Conflict
    );

    let mut changed_digest = signal_parts("evt-1");
    changed_digest.candidate_digest =
        Digest::new(DigestAlgorithm::Sha256, &"b".repeat(64)).expect("valid digest");
    assert_eq!(
        reconcile_workflow_signal(
            &state,
            &WorkflowSignal::validate(changed_digest).expect("valid signal")
        ),
        SignalReconciliation::Conflict
    );
}

#[test]
fn missing_event_is_absent() {
    let state = state_with(ready("evt-other"));
    assert_eq!(
        reconcile_workflow_signal(&state, &ready("evt-1")),
        SignalReconciliation::Absent
    );
}
