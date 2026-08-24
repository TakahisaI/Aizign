//! Optional, side-effect-free observation points for engine stage timing.

/// A bounded stage inside a submit or reconciliation use case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineStage {
    /// Load and decode the committed journal snapshot.
    JournalLoadDecode,
    /// Read commit metadata and the exact committed journal prefix.
    CommittedPrefixRead,
    /// Verify the committed prefix against its published SHA-256 digest.
    CommittedPrefixHash,
    /// Decode the verified prefix into journal entries.
    CommittedPrefixDecode,
    /// Replay committed events into workflow state.
    Replay,
    /// Run the pure submit decision or reconciliation classification.
    Decide,
    /// Durably append and publish an accepted event.
    AppendSync,
    /// Hash the whole prefix used by the next published commit point.
    PublishPrefixHash,
}

/// Optional observer supplied by the shell.
///
/// Observation has no error channel by design: metrics collection must never
/// turn a workflow acceptance into a failure. The engine does not read a
/// clock or perform I/O through this port; it only marks stage boundaries.
pub trait EngineObserver {
    /// A stage is about to start.
    fn stage_started(&mut self, stage: EngineStage);

    /// A stage finished, whether its result was successful or an error.
    /// `journal_entries` is present only after a successful committed load.
    fn stage_finished(&mut self, stage: EngineStage, journal_entries: Option<usize>);
}

pub(crate) struct NoopObserver;

impl EngineObserver for NoopObserver {
    fn stage_started(&mut self, _stage: EngineStage) {}

    fn stage_finished(&mut self, _stage: EngineStage, _journal_entries: Option<usize>) {}
}
