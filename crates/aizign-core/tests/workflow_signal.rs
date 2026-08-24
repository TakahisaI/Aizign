//! Cross-module behaviour of the workflow context: decide, apply, replay.

use aizign_core::workflow::{
    ApplyError, Command, Decision, ExpectedAssignment, Role, SignalKind, SignalParts,
    WorkflowError, WorkflowEvent, WorkflowSignal, WorkflowState, decide,
};
use aizign_core::{
    ArtifactRef, ArtifactRevision, AssignmentId, AttemptId, Digest, DigestAlgorithm, EventId,
    ShortErrorCode, WorkflowId,
};

fn digest(byte: char) -> Digest {
    Digest::new(DigestAlgorithm::Sha256, &byte.to_string().repeat(64)).unwrap()
}

fn expected() -> ExpectedAssignment {
    ExpectedAssignment {
        workflow_id: WorkflowId::new("wf-1").unwrap(),
        assignment_id: AssignmentId::new("as-impl").unwrap(),
        attempt_id: AttemptId::new("attempt-1").unwrap(),
        role: Role::Implementation,
        artifact_revision: ArtifactRevision::new("rev-a").unwrap(),
        candidate_digest: digest('a'),
        source_event_id: None,
    }
}

fn ready(event_id: &str) -> WorkflowSignal {
    let expected = expected();
    WorkflowSignal::validate(SignalParts {
        event_id: EventId::new(event_id).unwrap(),
        workflow_id: expected.workflow_id,
        assignment_id: expected.assignment_id,
        attempt_id: expected.attempt_id,
        role: expected.role,
        artifact_revision: expected.artifact_revision,
        candidate_digest: expected.candidate_digest,
        kind: SignalKind::ImplementationReady,
        finding_count: None,
        artifact_ref: None,
        evidence_digest: None,
        source_event_id: None,
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

fn submit_matching(signal: WorkflowSignal) -> Command {
    let expected = ExpectedAssignment {
        workflow_id: signal.workflow_id().clone(),
        assignment_id: signal.assignment_id().clone(),
        attempt_id: signal.attempt_id().clone(),
        role: signal.role(),
        artifact_revision: signal.artifact_revision().clone(),
        candidate_digest: signal.candidate_digest().clone(),
        source_event_id: signal.source_event_id().cloned(),
    };
    Command::SubmitSignal { signal, expected }
}

fn review_findings(event_id: &str, artifact_ref: &str, digest_byte: char) -> WorkflowSignal {
    WorkflowSignal::validate(SignalParts {
        event_id: EventId::new(event_id).unwrap(),
        workflow_id: WorkflowId::new("wf-1").unwrap(),
        assignment_id: AssignmentId::new("as-review").unwrap(),
        attempt_id: AttemptId::new("attempt-review").unwrap(),
        role: Role::Review,
        artifact_revision: ArtifactRevision::new("rev-a").unwrap(),
        candidate_digest: digest('a'),
        kind: SignalKind::ReviewFindings,
        finding_count: Some(1),
        artifact_ref: Some(ArtifactRef::new(artifact_ref).unwrap()),
        evidence_digest: Some(digest(digest_byte)),
        source_event_id: None,
        short_error_code: None,
    })
    .unwrap()
}

fn repair(event_id: &str, source_event_id: &str, revision: &str, byte: char) -> WorkflowSignal {
    WorkflowSignal::validate(SignalParts {
        event_id: EventId::new(event_id).unwrap(),
        workflow_id: WorkflowId::new("wf-1").unwrap(),
        assignment_id: AssignmentId::new("as-repair").unwrap(),
        attempt_id: AttemptId::new(event_id).unwrap(),
        role: Role::Implementation,
        artifact_revision: ArtifactRevision::new(revision).unwrap(),
        candidate_digest: digest(byte),
        kind: SignalKind::RepairSubmitted,
        finding_count: Some(1),
        artifact_ref: Some(ArtifactRef::new(event_id).unwrap()),
        evidence_digest: Some(digest(byte)),
        source_event_id: Some(EventId::new(source_event_id).unwrap()),
        short_error_code: None,
    })
    .unwrap()
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
    parts.attempt_id = AttemptId::new("attempt-2").unwrap();
    parts.role = Role::Review;
    parts.kind = SignalKind::ReviewPassed;
    parts.finding_count = Some(0);
    parts.artifact_revision = ArtifactRevision::new("rev-b").unwrap();
    parts.candidate_digest = digest('b');
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
            error: WorkflowError::AttemptMismatch { .. }
        }
    ));

    parts.attempt_id = AttemptId::new("attempt-1").unwrap();
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
        decide(
            &state,
            submit(WorkflowSignal::validate(parts.clone()).unwrap())
        ),
        Decision::Rejected {
            error: WorkflowError::CandidateDigestMismatch { .. }
        }
    ));

    parts.candidate_digest = digest('a');
    assert!(matches!(
        decide(&state, submit(WorkflowSignal::validate(parts).unwrap())),
        Decision::Duplicate { .. }
    ));
}

#[test]
fn immutable_candidate_and_evidence_references_reject_changed_content() {
    let mut state = WorkflowState::new();
    accept(&mut state, ready("evt-ready"));

    let mut changed_candidate = ready("evt-other").parts().clone();
    changed_candidate.candidate_digest = digest('b');
    let changed_candidate = WorkflowSignal::validate(changed_candidate).unwrap();
    assert!(matches!(
        decide(&state, submit_matching(changed_candidate)),
        Decision::Rejected {
            error: WorkflowError::CandidateConflict { .. }
        }
    ));

    let findings = review_findings("evt-findings-1", "review:stable", 'c');
    let Decision::Accepted { event } = decide(&state, submit_matching(findings.clone())) else {
        panic!("findings should be accepted")
    };
    state.apply(&event).unwrap();
    let mut changed_same_event = findings.parts().clone();
    changed_same_event.evidence_digest = Some(digest('d'));
    assert!(matches!(
        decide(
            &state,
            submit_matching(WorkflowSignal::validate(changed_same_event).unwrap())
        ),
        Decision::Rejected {
            error: WorkflowError::EventConflict { .. }
        }
    ));
    let changed_evidence = review_findings("evt-findings-2", "review:stable", 'd');
    assert!(matches!(
        decide(&state, submit_matching(changed_evidence)),
        Decision::Rejected {
            error: WorkflowError::EvidenceConflict { .. }
        }
    ));
}

#[test]
fn repair_causation_is_expected_available_and_consumed_once() {
    let findings = review_findings("evt-findings", "review:findings", 'c');
    let findings_event = WorkflowEvent::SignalAccepted {
        signal: findings.clone(),
    };
    let repair_signal = repair("evt-repair", "evt-findings", "rev-b", 'b');
    let repair_event = WorkflowEvent::SignalAccepted {
        signal: repair_signal.clone(),
    };
    let mut state = WorkflowState::replay([&findings_event]).unwrap();
    let other_findings = review_findings("evt-other-findings", "review:other", 'd');
    let Decision::Accepted { event } = decide(&state, submit_matching(other_findings)) else {
        panic!("other findings should be accepted")
    };
    state.apply(&event).unwrap();

    let mut wrong_expectation = submit_matching(repair_signal.clone());
    let Command::SubmitSignal { expected, .. } = &mut wrong_expectation;
    expected.source_event_id = Some(EventId::new("evt-other-findings").unwrap());
    assert!(matches!(
        decide(&state, wrong_expectation),
        Decision::Rejected {
            error: WorkflowError::CausationMismatch { .. }
        }
    ));

    let Decision::Accepted { event } = decide(&state, submit_matching(repair_signal.clone()))
    else {
        panic!("repair should be accepted")
    };
    state.apply(&event).unwrap();
    let mut changed_source = repair_signal.parts().clone();
    changed_source.source_event_id = Some(EventId::new("evt-other-findings").unwrap());
    assert!(matches!(
        decide(
            &state,
            submit_matching(WorkflowSignal::validate(changed_source).unwrap())
        ),
        Decision::Rejected {
            error: WorkflowError::EventConflict { .. }
        }
    ));
    assert!(matches!(
        decide(
            &state,
            submit_matching(repair("evt-repair-2", "evt-findings", "rev-c", 'c'))
        ),
        Decision::Rejected {
            error: WorkflowError::CausationUnavailable { .. }
        }
    ));

    let replayed = WorkflowState::replay([&findings_event, &repair_event]).unwrap();
    assert!(matches!(
        decide(&replayed, submit_matching(repair_signal)),
        Decision::Duplicate { .. }
    ));
    assert!(matches!(
        WorkflowState::replay([&repair_event]),
        Err(ApplyError::InvalidCausation { .. })
    ));
}

#[test]
fn duplicate_identity_compares_attempt_and_digest_content() {
    let mut state = WorkflowState::new();
    accept(&mut state, ready("evt-1"));

    let mut changed = ready("evt-1").parts().clone();
    changed.attempt_id = AttemptId::new("attempt-2").unwrap();
    let changed = WorkflowSignal::validate(changed).unwrap();
    assert!(matches!(
        decide(&state, submit_matching(changed)),
        Decision::Rejected {
            error: WorkflowError::EventConflict { .. }
        }
    ));

    let mut changed = ready("evt-1").parts().clone();
    changed.candidate_digest = digest('b');
    let changed = WorkflowSignal::validate(changed).unwrap();
    assert!(matches!(
        decide(&state, submit_matching(changed)),
        Decision::Rejected {
            error: WorkflowError::EventConflict { .. }
        }
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
fn replay_rejects_candidate_and_evidence_digest_rebinding() {
    let first = WorkflowEvent::SignalAccepted {
        signal: ready("evt-1"),
    };
    let mut changed_candidate = ready("evt-2").parts().clone();
    changed_candidate.candidate_digest = digest('b');
    let changed_candidate = WorkflowEvent::SignalAccepted {
        signal: WorkflowSignal::validate(changed_candidate).unwrap(),
    };
    assert!(matches!(
        WorkflowState::replay([&first, &changed_candidate]),
        Err(ApplyError::CandidateConflict { .. })
    ));

    let findings = WorkflowEvent::SignalAccepted {
        signal: review_findings("evt-findings-1", "review:stable", 'c'),
    };
    let changed_evidence = WorkflowEvent::SignalAccepted {
        signal: review_findings("evt-findings-2", "review:stable", 'd'),
    };
    assert!(matches!(
        WorkflowState::replay([&findings, &changed_evidence]),
        Err(ApplyError::EvidenceConflict { .. })
    ));
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
