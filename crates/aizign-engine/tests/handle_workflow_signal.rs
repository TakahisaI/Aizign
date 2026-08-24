//! The use case against the in-memory journal, including every way the
//! journal can fail and the one way it can lie (acknowledgement lost).

use aizign_core::EventId;
use aizign_core::workflow::{ApplyError, Command, WorkflowError, WorkflowEvent};
use aizign_engine::{ClockError, HandleError, JournalError, SignalOutcome, handle_workflow_signal};
use aizign_testkit::{FixedClock, MemoryJournal, signals};

fn submit(event_id: &str) -> Command {
    Command::SubmitSignal {
        signal: signals::implementation_ready(event_id),
        expected: signals::expected(),
    }
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
