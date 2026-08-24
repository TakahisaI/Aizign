//! The use case against the in-memory journal, including every way the
//! journal can fail and the one way it can lie (acknowledgement lost).

use aizign_core::workflow::{
    ApplyError, Command, ExpectedAssignment, Role, SignalKind, SignalParts, WorkflowError,
    WorkflowEvent, WorkflowSignal,
};
use aizign_core::{ArtifactRef, ArtifactRevision, AssignmentId, AttemptId, EventId, WorkflowId};
use aizign_engine::{ClockError, HandleError, JournalError, SignalOutcome, handle_workflow_signal};
use aizign_testkit::{FixedClock, MemoryJournal, signals};

fn submit(event_id: &str) -> Command {
    Command::SubmitSignal {
        signal: signals::implementation_ready(event_id),
        expected: signals::expected(),
    }
}

fn findings() -> WorkflowSignal {
    WorkflowSignal::validate(SignalParts {
        event_id: EventId::new("evt-findings").unwrap(),
        workflow_id: WorkflowId::new("wf-chain").unwrap(),
        assignment_id: AssignmentId::new("as-review").unwrap(),
        attempt_id: AttemptId::new("attempt-review").unwrap(),
        role: Role::Review,
        artifact_revision: ArtifactRevision::new("rev-a").unwrap(),
        candidate_digest: signals::digest('a'),
        kind: SignalKind::ReviewFindings,
        finding_count: Some(1),
        artifact_ref: Some(ArtifactRef::new("review:findings").unwrap()),
        evidence_digest: Some(signals::digest('c')),
        source_event_id: None,
        short_error_code: None,
    })
    .unwrap()
}

fn repair(event_id: &str) -> Command {
    let source_event_id = EventId::new("evt-findings").unwrap();
    let expected = ExpectedAssignment {
        workflow_id: WorkflowId::new("wf-chain").unwrap(),
        assignment_id: AssignmentId::new("as-repair").unwrap(),
        attempt_id: AttemptId::new("attempt-repair").unwrap(),
        role: Role::Implementation,
        artifact_revision: ArtifactRevision::new("rev-b").unwrap(),
        candidate_digest: signals::digest('b'),
        source_event_id: Some(source_event_id.clone()),
    };
    let signal = WorkflowSignal::validate(SignalParts {
        event_id: EventId::new(event_id).unwrap(),
        workflow_id: expected.workflow_id.clone(),
        assignment_id: expected.assignment_id.clone(),
        attempt_id: expected.attempt_id.clone(),
        role: expected.role,
        artifact_revision: expected.artifact_revision.clone(),
        candidate_digest: expected.candidate_digest.clone(),
        kind: SignalKind::RepairSubmitted,
        finding_count: Some(1),
        artifact_ref: Some(ArtifactRef::new("repair:result").unwrap()),
        evidence_digest: Some(signals::digest('d')),
        source_event_id: Some(source_event_id),
        short_error_code: None,
    })
    .unwrap();
    Command::SubmitSignal { signal, expected }
}

#[test]
fn accepts_then_recognizes_the_duplicate_from_the_journal_alone() {
    let mut journal = MemoryJournal::new();
    let clock = FixedClock::default();

    let outcome = handle_workflow_signal(&mut journal, &clock, submit("evt-1")).unwrap();
    let SignalOutcome::Accepted { entry } = outcome else {
        panic!("expected acceptance")
    };
    assert_eq!(entry.seq, 1);
    assert_eq!(entry.at, signals::at(0));
    assert_eq!(journal.entries().len(), 1, "accepted means appended");

    let outcome = handle_workflow_signal(&mut journal, &clock, submit("evt-1")).unwrap();
    assert_eq!(
        outcome,
        SignalOutcome::Duplicate {
            event_id: EventId::new("evt-1").unwrap()
        }
    );
    assert_eq!(journal.entries().len(), 1, "duplicates append nothing");
}

#[test]
fn rejections_append_nothing() {
    let mut journal = MemoryJournal::new();
    let clock = FixedClock::default();
    handle_workflow_signal(&mut journal, &clock, submit("evt-1")).unwrap();

    let conflicting = Command::SubmitSignal {
        signal: signals::blocked("evt-1", "X"),
        expected: signals::expected(),
    };
    let error = handle_workflow_signal(&mut journal, &clock, conflicting).unwrap_err();
    assert!(matches!(
        error,
        HandleError::Rejected(WorkflowError::EventConflict { .. })
    ));
    assert_eq!(error.code(), "EVENT_CONFLICT");
    assert_eq!(journal.entries().len(), 1);
}

#[test]
fn journal_failures_surface_with_their_codes_and_are_not_retried() {
    let clock = FixedClock::default();

    let mut journal = MemoryJournal::new();
    journal.fail_next_load(JournalError::Locked);
    let error = handle_workflow_signal(&mut journal, &clock, submit("evt-1")).unwrap_err();
    assert_eq!(error, HandleError::Journal(JournalError::Locked));
    assert_eq!(error.code(), "JOURNAL_LOCKED");

    let mut journal = MemoryJournal::new();
    journal.fail_next_append(JournalError::Unavailable {
        detail: "disk".to_owned(),
    });
    let error = handle_workflow_signal(&mut journal, &clock, submit("evt-1")).unwrap_err();
    assert_eq!(error.code(), "JOURNAL_UNAVAILABLE");
    assert!(
        journal.entries().is_empty(),
        "a rejected append stores nothing"
    );
}

#[test]
fn a_lost_acknowledgement_is_reported_as_unknown_and_the_entry_may_exist() {
    let clock = FixedClock::default();
    let mut journal = MemoryJournal::new();
    journal.lose_next_append_acknowledgement();

    let error = handle_workflow_signal(&mut journal, &clock, submit("evt-1")).unwrap_err();
    assert_eq!(error.code(), "JOURNAL_OUTCOME_UNKNOWN");
    assert!(matches!(
        error,
        HandleError::Journal(JournalError::OutcomeUnknown { .. })
    ));
    // The engine did exactly one append and reported unknown. Whether the
    // entry exists is for reconciliation to discover, not for a retry to guess:
    assert_eq!(journal.entries().len(), 1);
    let outcome = handle_workflow_signal(&mut journal, &clock, submit("evt-1")).unwrap();
    assert!(matches!(outcome, SignalOutcome::Duplicate { .. }));
}

#[test]
fn inconsistent_journals_are_corrupt_not_reinterpreted() {
    let clock = FixedClock::default();
    let mut journal = MemoryJournal::new();
    let event = WorkflowEvent::SignalAccepted {
        signal: signals::implementation_ready("evt-1"),
    };
    aizign_engine::Journal::append(&mut journal, &event, signals::at(0)).unwrap();
    aizign_engine::Journal::append(&mut journal, &event, signals::at(1)).unwrap();

    let error = handle_workflow_signal(&mut journal, &clock, submit("evt-2")).unwrap_err();
    assert_eq!(
        error,
        HandleError::Replay(ApplyError::DuplicateEvent {
            event_id: EventId::new("evt-1").unwrap()
        })
    );
    assert_eq!(error.code(), "JOURNAL_CORRUPT");
    assert_eq!(
        journal.entries().len(),
        2,
        "nothing appended to a corrupt journal"
    );
}

#[test]
fn clock_failures_prevent_the_append() {
    let mut journal = MemoryJournal::new();
    let clock = FixedClock::failing(ClockError::OutOfRange);
    let error = handle_workflow_signal(&mut journal, &clock, submit("evt-1")).unwrap_err();
    assert_eq!(error, HandleError::Clock(ClockError::OutOfRange));
    assert!(journal.entries().is_empty());
}

#[test]
fn replay_preserves_repair_causation_and_duplicate_semantics() {
    let clock = FixedClock::default();
    let mut journal = MemoryJournal::new();
    let findings_event = WorkflowEvent::SignalAccepted { signal: findings() };
    aizign_engine::Journal::append(&mut journal, &findings_event, signals::at(0)).unwrap();

    assert!(matches!(
        handle_workflow_signal(&mut journal, &clock, repair("evt-repair")),
        Ok(SignalOutcome::Accepted { .. })
    ));
    assert!(matches!(
        handle_workflow_signal(&mut journal, &clock, repair("evt-repair")),
        Ok(SignalOutcome::Duplicate { .. })
    ));
    let error = handle_workflow_signal(&mut journal, &clock, repair("evt-repair-2")).unwrap_err();
    assert!(matches!(
        &error,
        HandleError::Rejected(WorkflowError::CausationUnavailable { .. })
    ));
    assert_eq!(error.code(), "CAUSATION_MISMATCH");
    assert_eq!(journal.entries().len(), 2);
}
