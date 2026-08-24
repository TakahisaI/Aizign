//! Cross-module behaviour of the workflow context: decide, apply, replay.

use aizign_core::workflow::{
    ApplyError, Command, Decision, ExpectedAssignment, Role, SignalKind, SignalParts,
    WorkflowError, WorkflowEvent, WorkflowSignal, WorkflowState, decide,
};
use aizign_core::{ArtifactRevision, AssignmentId, EventId, ShortErrorCode, WorkflowId};

fn expected() -> ExpectedAssignment {
    ExpectedAssignment {
        workflow_id: WorkflowId::new("wf-1").unwrap(),
        assignment_id: AssignmentId::new("as-impl").unwrap(),
        role: Role::Implementation,
        artifact_revision: ArtifactRevision::new("rev-a").unwrap(),
    }
}

fn ready(event_id: &str) -> WorkflowSignal {
    let expected = expected();
    WorkflowSignal::validate(SignalParts {
        event_id: EventId::new(event_id).unwrap(),
        workflow_id: expected.workflow_id,
        assignment_id: expected.assignment_id,
        role: expected.role,
        artifact_revision: expected.artifact_revision,
        kind: SignalKind::ImplementationReady,
        finding_count: None,
        artifact_ref: None,
        short_error_code: None,
    })
    .unwrap()
}

fn blocked(event_id: &str, code: &str) -> WorkflowSignal {
    let mut parts = ready(event_id).parts().clone();
    parts.kind = SignalKind::Blocked;
    parts.short_error_code = Some(ShortErrorCode::new(code).unwrap());
    WorkflowSignal::validate(parts).unwrap()
}

fn submit(signal: WorkflowSignal) -> Command {
    Command::SubmitSignal {
        signal,
        expected: expected(),
    }
}

fn accept(state: &mut WorkflowState, signal: WorkflowSignal) {
    match decide(state, submit(signal)) {
        Decision::Accepted { event } => state.apply(&event).unwrap(),
        other => panic!("expected acceptance, got {other:?}"),
    }
}

#[test]
fn a_new_signal_is_accepted_and_becomes_state_only_after_apply() {
    let mut state = WorkflowState::new();
    let decision = decide(&state, submit(ready("evt-1")));
    let Decision::Accepted { event } = decision else {
        panic!("expected Accepted, got {decision:?}");
    };
    assert!(state.is_empty(), "deciding never mutates state");

    state.apply(&event).unwrap();
    assert_eq!(state.len(), 1);
    assert_eq!(
        state
            .accepted(&EventId::new("evt-1").unwrap())
            .map(WorkflowSignal::kind),
        Some(SignalKind::ImplementationReady)
    );
}

#[test]
fn same_identity_same_content_is_a_duplicate() {
    let mut state = WorkflowState::new();
    accept(&mut state, ready("evt-1"));
    assert_eq!(
        decide(&state, submit(ready("evt-1"))),
        Decision::Duplicate {
            event_id: EventId::new("evt-1").unwrap()
        }
    );
    assert_eq!(state.len(), 1);
}

#[test]
fn same_identity_different_content_is_a_conflict() {
    let mut state = WorkflowState::new();
    accept(&mut state, ready("evt-1"));
    assert_eq!(
        decide(&state, submit(blocked("evt-1", "TOOL_FAILED"))),
        Decision::Rejected {
            error: WorkflowError::EventConflict {
                event_id: EventId::new("evt-1").unwrap()
            }
        }
    );
    // Even a one-field difference is a conflict, never a silent overwrite.
    accept(&mut state, blocked("evt-2", "A"));
    assert!(matches!(
        decide(&state, submit(blocked("evt-2", "B"))),
        Decision::Rejected {
            error: WorkflowError::EventConflict { .. }
        }
    ));
}

#[test]
fn conflicts_are_detected_across_workflows() {
    // An event id accepted under another workflow still conflicts: event ids
    // are global, and the later signal passes the expectation check on its own.
    let mut parts = ready("evt-shared").parts().clone();
    parts.workflow_id = WorkflowId::new("wf-other").unwrap();
    let foreign = WorkflowSignal::validate(parts).unwrap();
    let mut state = WorkflowState::new();
    state
        .apply(&WorkflowEvent::SignalAccepted { signal: foreign })
        .unwrap();

    assert!(matches!(
        decide(&state, submit(ready("evt-shared"))),
        Decision::Rejected {
            error: WorkflowError::EventConflict { .. }
        }
    ));
}

#[test]
fn expectation_is_checked_in_order_before_duplicates() {
    let mut state = WorkflowState::new();
    accept(&mut state, ready("evt-1"));

    let mut parts = ready("evt-1").parts().clone();
    parts.workflow_id = WorkflowId::new("wf-2").unwrap();
    parts.assignment_id = AssignmentId::new("as-2").unwrap();
    parts.role = Role::Review;
    parts.kind = SignalKind::ReviewPassed;
    parts.finding_count = Some(0);
    parts.artifact_revision = ArtifactRevision::new("rev-b").unwrap();
    let all_wrong = WorkflowSignal::validate(parts.clone()).unwrap();
    assert!(matches!(
        decide(&state, submit(all_wrong)),
        Decision::Rejected {
            error: WorkflowError::WorkflowMismatch { .. }
        }
    ));

    parts.workflow_id = WorkflowId::new("wf-1").unwrap();
    assert!(matches!(
        decide(
            &state,
            submit(WorkflowSignal::validate(parts.clone()).unwrap())
        ),
        Decision::Rejected {
            error: WorkflowError::AssignmentMismatch { .. }
        }
    ));

    parts.assignment_id = AssignmentId::new("as-impl").unwrap();
    assert!(matches!(
        decide(
            &state,
            submit(WorkflowSignal::validate(parts.clone()).unwrap())
        ),
        Decision::Rejected {
            error: WorkflowError::RoleMismatch { .. }
        }
    ));

    parts.role = Role::Implementation;
    parts.kind = SignalKind::ImplementationReady;
    parts.finding_count = None;
    assert!(matches!(
        decide(
            &state,
            submit(WorkflowSignal::validate(parts.clone()).unwrap())
        ),
        Decision::Rejected {
            error: WorkflowError::RevisionMismatch { .. }
        }
    ));

    // With the expectation satisfied, the duplicate check finally runs.
    parts.artifact_revision = ArtifactRevision::new("rev-a").unwrap();
    assert!(matches!(
        decide(&state, submit(WorkflowSignal::validate(parts).unwrap())),
        Decision::Duplicate { .. }
    ));
}

#[test]
fn replay_rebuilds_state_and_refuses_repeated_events() {
    let events = [
        WorkflowEvent::SignalAccepted {
            signal: ready("evt-1"),
        },
        WorkflowEvent::SignalAccepted {
            signal: blocked("evt-2", "X"),
        },
    ];
    let state = WorkflowState::replay(&events).unwrap();
    assert_eq!(state.len(), 2);

    let corrupt = [
        WorkflowEvent::SignalAccepted {
            signal: ready("evt-1"),
        },
        WorkflowEvent::SignalAccepted {
            signal: ready("evt-1"),
        },
    ];
    assert_eq!(
        WorkflowState::replay(&corrupt),
        Err(ApplyError::DuplicateEvent {
            event_id: EventId::new("evt-1").unwrap()
        })
    );
}

#[test]
fn rejections_carry_registered_error_codes() {
    let state = WorkflowState::new();
    let mut parts = ready("evt-1").parts().clone();
    parts.artifact_revision = ArtifactRevision::new("rev-b").unwrap();
    let Decision::Rejected { error } =
        decide(&state, submit(WorkflowSignal::validate(parts).unwrap()))
    else {
        panic!("expected rejection");
    };
    assert_eq!(error.code(), "REVISION_MISMATCH");
    assert_eq!(
        error.to_string(),
        "revision mismatch: expected rev-a, got rev-b"
    );
}
