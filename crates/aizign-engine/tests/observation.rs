//! Stage observation is complete, ordered, and unable to alter outcomes.

use aizign_core::BoundedTimestamp;
use aizign_core::workflow::{Command, WorkflowEvent};
use aizign_engine::{
    EngineObserver, EngineStage, Journal, JournalEntry, JournalError, JournalReader, SignalOutcome,
    handle_workflow_signal, handle_workflow_signal_observed, reconcile_workflow_signal_observed,
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

struct PublishingJournal(MemoryJournal);

impl JournalReader for PublishingJournal {
    fn load_committed(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        self.0.load_committed()
    }
}

impl Journal for PublishingJournal {
    fn append(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
    ) -> Result<JournalEntry, JournalError> {
        self.0.append(event, at)
    }

    fn append_observed(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
        observer: &mut dyn EngineObserver,
    ) -> Result<JournalEntry, JournalError> {
        observer.stage_started(EngineStage::PublishPrefixHash);
        observer.stage_finished(EngineStage::PublishPrefixHash, None);
        self.0.append(event, at)
    }
}

struct PanicsOnPublish;

impl EngineObserver for PanicsOnPublish {
    fn stage_started(&mut self, stage: EngineStage) {
        assert_ne!(
            stage,
            EngineStage::PublishPrefixHash,
            "metric collector failed"
        );
    }

    fn stage_finished(&mut self, _stage: EngineStage, _journal_entries: Option<usize>) {}
}

#[test]
fn panicking_observer_cannot_change_the_durable_outcome() {
    let mut journal = PublishingJournal(MemoryJournal::new());
    let outcome = handle_workflow_signal_observed(
        &mut journal,
        &FixedClock::default(),
        submit("evt-observer-panic"),
        &mut PanicsOnPublish,
    )
    .unwrap();
    assert!(matches!(outcome, SignalOutcome::Accepted { .. }));
    assert_eq!(journal.0.entries().len(), 1);
}

struct PlainOnlyJournal(MemoryJournal);

impl JournalReader for PlainOnlyJournal {
    fn load_committed(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        self.0.load_committed()
    }

    fn load_committed_observed(
        &mut self,
        _observer: &mut dyn EngineObserver,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        panic!("plain execution must not use the observed read path");
    }
}

impl Journal for PlainOnlyJournal {
    fn append(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
    ) -> Result<JournalEntry, JournalError> {
        self.0.append(event, at)
    }

    fn append_observed(
        &mut self,
        _event: &WorkflowEvent,
        _at: BoundedTimestamp,
        _observer: &mut dyn EngineObserver,
    ) -> Result<JournalEntry, JournalError> {
        panic!("plain execution must not use the observed append path");
    }
}

#[test]
fn unobserved_api_never_calls_observed_journal_ports() {
    let mut journal = PlainOnlyJournal(MemoryJournal::new());
    let outcome = handle_workflow_signal(
        &mut journal,
        &FixedClock::default(),
        submit("evt-unobserved"),
    )
    .unwrap();
    assert!(matches!(outcome, SignalOutcome::Accepted { .. }));
    assert_eq!(journal.0.entries().len(), 1);
}
