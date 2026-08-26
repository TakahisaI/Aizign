//! Optional, side-effect-free observation points for engine stage timing.

use std::panic::{AssertUnwindSafe, catch_unwind};

/// A bounded use-case stage inside submit or reconciliation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineStage {
    /// Load and decode the committed journal snapshot.
    JournalLoadDecode,
    /// Replay committed events into workflow state.
    Replay,
    /// Run the pure submit decision or reconciliation classification.
    Decide,
    /// Durably append and publish an accepted event.
    AppendSync,
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

/// Prevents an observer panic from crossing the engine boundary.
///
/// The first panic disables the wrapped observer for the rest of the operation.
pub struct BestEffortObserver<'a> {
    inner: &'a mut dyn EngineObserver,
    enabled: bool,
}

impl<'a> BestEffortObserver<'a> {
    /// Wraps one caller-supplied observer.
    pub fn new(inner: &'a mut dyn EngineObserver) -> Self {
        Self {
            inner,
            enabled: true,
        }
    }

    fn notify(&mut self, operation: impl FnOnce(&mut dyn EngineObserver)) {
        if !self.enabled {
            return;
        }
        if catch_unwind(AssertUnwindSafe(|| operation(self.inner))).is_err() {
            self.enabled = false;
        }
    }
}

impl EngineObserver for BestEffortObserver<'_> {
    fn stage_started(&mut self, stage: EngineStage) {
        self.notify(|observer| observer.stage_started(stage));
    }

    fn stage_finished(&mut self, stage: EngineStage, journal_entries: Option<usize>) {
        self.notify(|observer| observer.stage_finished(stage, journal_entries));
    }
}
