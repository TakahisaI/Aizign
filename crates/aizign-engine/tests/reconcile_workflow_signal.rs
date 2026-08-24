//! Read-only engine reconciliation over committed journal snapshots.

use aizign_core::ShortErrorCode;
use aizign_core::recovery::SignalReconciliation;
use aizign_core::workflow::{SignalKind, WorkflowEvent, WorkflowSignal};
use aizign_engine::{Journal, JournalError, ReconcileError, reconcile_workflow_signal};
use aizign_testkit::{MemoryJournal, signals};

fn event(signal: WorkflowSignal) -> WorkflowEvent {
    WorkflowEvent::SignalAccepted { signal }
}

#[test]
fn classifies_exact_conflicting_and_absent_signals_without_appending() {
    let mut journal = MemoryJournal::new();
    let accepted = signals::implementation_ready("evt-1");
    journal
        .append(&event(accepted.clone()), signals::at(0))
        .unwrap();
    let before = journal.entries().to_vec();

    assert_eq!(
        reconcile_workflow_signal(&mut journal, &accepted).unwrap(),
        SignalReconciliation::Accepted
    );
    let mut changed = accepted.parts().clone();
    changed.kind = SignalKind::Blocked;
    changed.short_error_code = Some(ShortErrorCode::new("STOPPED").unwrap());
    let changed = WorkflowSignal::validate(changed).unwrap();
    assert_eq!(
        reconcile_workflow_signal(&mut journal, &changed).unwrap(),
        SignalReconciliation::Conflict
    );
    assert_eq!(
        reconcile_workflow_signal(&mut journal, &signals::implementation_ready("evt-absent"))
            .unwrap(),
        SignalReconciliation::Absent
    );
    assert_eq!(journal.entries(), before, "reconciliation never appends");
}

#[test]
fn snapshot_and_replay_failures_remain_unknown_to_the_shell() {
    let mut unavailable = MemoryJournal::new();
    unavailable.fail_next_load(JournalError::Unavailable {
        detail: "injected".to_owned(),
    });
    let error =
        reconcile_workflow_signal(&mut unavailable, &signals::implementation_ready("evt-1"))
            .unwrap_err();
    assert_eq!(error.code(), "JOURNAL_UNAVAILABLE");

    let mut corrupt = MemoryJournal::new();
    let duplicate = event(signals::implementation_ready("evt-1"));
    corrupt.append(&duplicate, signals::at(0)).unwrap();
    corrupt.append(&duplicate, signals::at(1)).unwrap();
    assert!(matches!(
        reconcile_workflow_signal(&mut corrupt, &signals::implementation_ready("evt-1")),
        Err(ReconcileError::Replay(_))
    ));
}
