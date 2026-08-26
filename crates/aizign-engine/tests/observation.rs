//! Stage observation is complete, ordered, and unable to alter outcomes.

use aizign_core::workflow::{Command, SignalKind, WorkflowEvent, WorkflowSignal};
use aizign_core::{BoundedTimestamp, ShortErrorCode};
use aizign_engine::{
    Clock, EngineObserver, EngineStage, HandleError, Journal, JournalEntry, JournalError,
    JournalReader, ReconcileError, SignalOutcome, handle_workflow_signal,
    handle_workflow_signal_observed, reconcile_workflow_signal, reconcile_workflow_signal_observed,
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

fn event(signal: WorkflowSignal) -> WorkflowEvent {
    WorkflowEvent::SignalAccepted { signal }
}

fn blocked(event_id: &str) -> WorkflowSignal {
    let mut parts = signals::implementation_ready(event_id).parts().clone();
    parts.kind = SignalKind::Blocked;
    parts.short_error_code = Some(ShortErrorCode::new("STOPPED").unwrap());
    WorkflowSignal::validate(parts).unwrap()
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
    let mut plain_journal = PublishingJournal(MemoryJournal::new());
    let plain = handle_workflow_signal(
        &mut plain_journal,
        &FixedClock::default(),
        submit("evt-observer-panic"),
    );
    let mut observed_journal = PublishingJournal(MemoryJournal::new());
    let observed = handle_workflow_signal_observed(
        &mut observed_journal,
        &FixedClock::default(),
        submit("evt-observer-panic"),
        &mut PanicsOnPublish,
    );
    assert_eq!(observed, plain);
    assert!(matches!(observed, Ok(SignalOutcome::Accepted { .. })));
    assert_eq!(observed_journal.0.entries(), plain_journal.0.entries());
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PortCalls {
    plain_load: usize,
    observed_load: usize,
    plain_append: usize,
    observed_append: usize,
}

#[derive(Default)]
struct ProbeJournal {
    inner: MemoryJournal,
    calls: PortCalls,
}

impl ProbeJournal {
    fn configured(configure: impl FnOnce(&mut MemoryJournal)) -> Self {
        let mut journal = Self::default();
        configure(&mut journal.inner);
        journal
    }

    fn entries(&self) -> &[JournalEntry] {
        self.inner.entries()
    }
}

impl JournalReader for ProbeJournal {
    fn load_committed(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        self.calls.plain_load += 1;
        self.inner.load_committed()
    }

    fn load_committed_observed(
        &mut self,
        observer: &mut dyn EngineObserver,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        self.calls.observed_load += 1;
        self.inner.load_committed_observed(observer)
    }
}

impl Journal for ProbeJournal {
    fn append(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
    ) -> Result<JournalEntry, JournalError> {
        self.calls.plain_append += 1;
        self.inner.append(event, at)
    }

    fn append_observed(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
        observer: &mut dyn EngineObserver,
    ) -> Result<JournalEntry, JournalError> {
        self.calls.observed_append += 1;
        self.inner.append_observed(event, at, observer)
    }
}

fn assert_stage_pairs(trace: &Trace, expected: &[EngineStage]) {
    let actual = trace
        .0
        .iter()
        .map(|(boundary, stage, _)| (*boundary, *stage))
        .collect::<Vec<_>>();
    let expected = expected
        .iter()
        .flat_map(|stage| [("start", *stage), ("finish", *stage)])
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}

fn compare_submit_modes(
    name: &str,
    configure: impl Fn(&mut MemoryJournal),
    command: Command,
    clock: &impl Clock,
    append_calls: usize,
    stages: &[EngineStage],
) -> Result<SignalOutcome, HandleError> {
    let mut plain_journal = ProbeJournal::configured(|journal| configure(journal));
    let mut observed_journal = ProbeJournal::configured(configure);
    let plain = handle_workflow_signal(&mut plain_journal, clock, command.clone());
    let mut trace = Trace::default();
    let observed =
        handle_workflow_signal_observed(&mut observed_journal, clock, command, &mut trace);

    assert_eq!(observed, plain, "result differs for {name}");
    assert_eq!(
        observed_journal.entries(),
        plain_journal.entries(),
        "journal differs for {name}"
    );
    assert_eq!(
        plain_journal.calls,
        PortCalls {
            plain_load: 1,
            plain_append: append_calls,
            ..PortCalls::default()
        },
        "plain ports differ for {name}"
    );
    assert_eq!(
        observed_journal.calls,
        PortCalls {
            observed_load: 1,
            observed_append: append_calls,
            ..PortCalls::default()
        },
        "observed ports differ for {name}"
    );
    assert_stage_pairs(&trace, stages);
    observed
}

fn compare_reconcile_modes(
    name: &str,
    configure: impl Fn(&mut MemoryJournal),
    signal: &WorkflowSignal,
    stages: &[EngineStage],
) -> Result<aizign_core::recovery::SignalReconciliation, ReconcileError> {
    let mut plain_journal = ProbeJournal::configured(|journal| configure(journal));
    let mut observed_journal = ProbeJournal::configured(configure);
    let plain = reconcile_workflow_signal(&mut plain_journal, signal);
    let mut trace = Trace::default();
    let observed = reconcile_workflow_signal_observed(&mut observed_journal, signal, &mut trace);

    assert_eq!(observed, plain, "result differs for {name}");
    assert_eq!(
        observed_journal.entries(),
        plain_journal.entries(),
        "journal differs for {name}"
    );
    assert_eq!(
        plain_journal.calls,
        PortCalls {
            plain_load: 1,
            ..PortCalls::default()
        },
        "plain ports differ for {name}"
    );
    assert_eq!(
        observed_journal.calls,
        PortCalls {
            observed_load: 1,
            ..PortCalls::default()
        },
        "observed ports differ for {name}"
    );
    assert_stage_pairs(&trace, stages);
    observed
}

#[test]
fn plain_and_observed_submit_share_every_semantic_outcome() {
    let all_stages = [
        EngineStage::JournalLoadDecode,
        EngineStage::Replay,
        EngineStage::Decide,
        EngineStage::AppendSync,
    ];
    let through_decide = &all_stages[..3];

    compare_submit_modes(
        "accepted",
        |_| {},
        submit("evt-accepted"),
        &FixedClock::default(),
        1,
        &all_stages,
    )
    .unwrap();
    compare_submit_modes(
        "duplicate",
        |journal| {
            journal
                .append(
                    &event(signals::implementation_ready("evt-duplicate")),
                    signals::at(0),
                )
                .unwrap();
        },
        submit("evt-duplicate"),
        &FixedClock::default(),
        0,
        through_decide,
    )
    .unwrap();
    compare_submit_modes(
        "rejected",
        |journal| {
            journal
                .append(
                    &event(signals::implementation_ready("evt-conflict")),
                    signals::at(0),
                )
                .unwrap();
        },
        Command::SubmitSignal {
            signal: blocked("evt-conflict"),
            expected: signals::expected(),
        },
        &FixedClock::default(),
        0,
        through_decide,
    )
    .unwrap_err();
}

#[test]
fn plain_and_observed_submit_share_every_failure_path() {
    let all_stages = [
        EngineStage::JournalLoadDecode,
        EngineStage::Replay,
        EngineStage::Decide,
        EngineStage::AppendSync,
    ];
    compare_submit_modes(
        "load failure",
        |journal| journal.fail_next_load(JournalError::Locked),
        submit("evt-load"),
        &FixedClock::default(),
        0,
        &all_stages[..1],
    )
    .unwrap_err();
    compare_submit_modes(
        "replay failure",
        |journal| {
            let repeated = event(signals::implementation_ready("evt-replay"));
            journal.append(&repeated, signals::at(0)).unwrap();
            journal.append(&repeated, signals::at(1)).unwrap();
        },
        submit("evt-new"),
        &FixedClock::default(),
        0,
        &all_stages[..2],
    )
    .unwrap_err();
    compare_submit_modes(
        "clock failure",
        |_| {},
        submit("evt-clock"),
        &FixedClock::failing(aizign_engine::ClockError::OutOfRange),
        0,
        &all_stages[..3],
    )
    .unwrap_err();
    compare_submit_modes(
        "append failure",
        |journal| {
            journal.fail_next_append(JournalError::Unavailable {
                detail: "injected".to_owned(),
            });
        },
        submit("evt-append"),
        &FixedClock::default(),
        1,
        &all_stages,
    )
    .unwrap_err();
    compare_submit_modes(
        "append outcome unknown",
        MemoryJournal::lose_next_append_acknowledgement,
        submit("evt-unknown"),
        &FixedClock::default(),
        1,
        &all_stages,
    )
    .unwrap_err();
}

#[test]
fn plain_and_observed_reconcile_share_every_disposition_and_unknown_path() {
    let all_stages = [
        EngineStage::JournalLoadDecode,
        EngineStage::Replay,
        EngineStage::Decide,
    ];
    let accepted = signals::implementation_ready("evt-reconcile");

    compare_reconcile_modes(
        "accepted",
        |journal| {
            journal
                .append(&event(accepted.clone()), signals::at(0))
                .unwrap();
        },
        &accepted,
        &all_stages,
    )
    .unwrap();
    compare_reconcile_modes(
        "conflict",
        |journal| {
            journal
                .append(&event(accepted.clone()), signals::at(0))
                .unwrap();
        },
        &blocked("evt-reconcile"),
        &all_stages,
    )
    .unwrap();
    compare_reconcile_modes(
        "absent",
        |_| {},
        &signals::implementation_ready("evt-absent"),
        &all_stages,
    )
    .unwrap();
    compare_reconcile_modes(
        "load failure",
        |journal| journal.fail_next_load(JournalError::Locked),
        &accepted,
        &all_stages[..1],
    )
    .unwrap_err();
    compare_reconcile_modes(
        "replay failure",
        |journal| {
            let repeated = event(accepted.clone());
            journal.append(&repeated, signals::at(0)).unwrap();
            journal.append(&repeated, signals::at(1)).unwrap();
        },
        &accepted,
        &all_stages[..2],
    )
    .unwrap_err();
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
    assert_eq!(
        reconcile_workflow_signal(
            &mut journal,
            &signals::implementation_ready("evt-unobserved")
        )
        .unwrap(),
        aizign_core::recovery::SignalReconciliation::Accepted
    );
}
