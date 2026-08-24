//! Stage observation is complete, ordered, and unable to alter outcomes.

use aizign_core::workflow::Command;
use aizign_engine::{
    EngineObserver, EngineStage, SignalOutcome, handle_workflow_signal_observed,
    reconcile_workflow_signal_observed,
};
use aizign_testkit::{FixedClock, MemoryJournal, signals};

#[derive(Default)]
struct Trace(Vec<(&'static str, EngineStage, Option<usize>)>);

impl EngineObserver for Trace {
    fn stage_started(&mut self, stage: EngineStage) {
        self.0.push(("start", stage, None));
    }

    fn stage_finished(&mut self, stage: EngineStage, journal_entries: Option<usize>) {
        self.0.push(("finish", stage, journal_entries));
    }
}

fn submit(event_id: &str) -> Command {
    Command::SubmitSignal {
        signal: signals::implementation_ready(event_id),
        expected: signals::expected(),
    }
}

#[test]
fn accepted_submit_observes_load_replay_decide_and_append() {
    let mut journal = MemoryJournal::new();
    let mut trace = Trace::default();
    let outcome = handle_workflow_signal_observed(
        &mut journal,
        &FixedClock::default(),
        submit("evt-observed"),
        &mut trace,
    )
    .unwrap();
    assert!(matches!(outcome, SignalOutcome::Accepted { .. }));
    assert_eq!(
        trace.0,
        [
            ("start", EngineStage::JournalLoadDecode, None),
            ("finish", EngineStage::JournalLoadDecode, Some(0)),
            ("start", EngineStage::Replay, None),
            ("finish", EngineStage::Replay, None),
            ("start", EngineStage::Decide, None),
            ("finish", EngineStage::Decide, None),
            ("start", EngineStage::AppendSync, None),
            ("finish", EngineStage::AppendSync, None),
        ]
    );
}

#[test]
fn reconciliation_uses_the_shared_read_only_stage_vocabulary() {
    let mut journal = MemoryJournal::new();
    let signal = signals::implementation_ready("evt-absent");
    let mut trace = Trace::default();
    let outcome = reconcile_workflow_signal_observed(&mut journal, &signal, &mut trace).unwrap();
    assert_eq!(outcome, aizign_core::recovery::SignalReconciliation::Absent);
    assert_eq!(
        trace.0,
        [
            ("start", EngineStage::JournalLoadDecode, None),
            ("finish", EngineStage::JournalLoadDecode, Some(0)),
            ("start", EngineStage::Replay, None),
            ("finish", EngineStage::Replay, None),
            ("start", EngineStage::Decide, None),
            ("finish", EngineStage::Decide, None),
        ]
    );
}
