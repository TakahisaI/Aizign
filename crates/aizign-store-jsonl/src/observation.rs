//! Optional, metadata-only observations owned by the JSONL store.
//!
//! The store owns the physical journal stages because the generic engine port
//! deliberately exposes only ordinary load and append operations.  These
//! events are therefore source-qualified store observations, not engine
//! use-case stages or a public timing contract.

use std::panic::{AssertUnwindSafe, catch_unwind};

/// A bounded physical stage inside the JSONL store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreStage {
    /// Open the existing or newly initialized store artifacts.
    JournalOpen,
    /// Read commit metadata and the exact committed journal prefix.
    CommittedPrefixRead,
    /// Verify the committed prefix against its published SHA-256 digest.
    CommittedPrefixHash,
    /// Decode the verified prefix into journal entries.
    CommittedPrefixDecode,
    /// Hash the whole prefix used by the next published commit point.
    PublishPrefixHash,
}

/// One metadata-only observation emitted by the JSONL store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreObservation {
    /// A physical stage is about to start.
    StageStarted(StoreStage),
    /// A physical stage has finished, including when its operation returns an
    /// error.
    StageFinished(StoreStage),
    /// The physical journal length after a successful store open.
    JournalPhysicalBytes(u64),
}

/// Optional sink for store-owned physical observations.
pub trait StoreObserver {
    /// Receives one store observation.  Implementations should keep this
    /// callback metadata-only; the store never uses its return value.
    fn observe(&mut self, observation: StoreObservation);
}

/// Isolates observer panics from store operations.
///
/// The first panic disables the wrapped observer for the remainder of the
/// operation.  A disabled observer is never called again, while journal
/// results and errors continue unchanged.
pub struct BestEffortStoreObserver<'a> {
    inner: &'a mut dyn StoreObserver,
    enabled: bool,
}

impl<'a> BestEffortStoreObserver<'a> {
    /// Wrap one caller-supplied observer.
    pub fn new(inner: &'a mut dyn StoreObserver) -> Self {
        Self {
            inner,
            enabled: true,
        }
    }

    /// Deliver one observation unless a previous callback panicked.
    pub fn observe(&mut self, observation: StoreObservation) {
        if !self.enabled {
            return;
        }
        if catch_unwind(AssertUnwindSafe(|| self.inner.observe(observation))).is_err() {
            self.enabled = false;
        }
    }
}

impl StoreObserver for BestEffortStoreObserver<'_> {
    fn observe(&mut self, observation: StoreObservation) {
        BestEffortStoreObserver::observe(self, observation);
    }
}

#[cfg(test)]
mod tests {
    use super::{BestEffortStoreObserver, StoreObservation, StoreObserver, StoreStage};

    struct PanicOnce {
        calls: usize,
    }

    impl StoreObserver for PanicOnce {
        fn observe(&mut self, _observation: StoreObservation) {
            self.calls += 1;
            assert!(self.calls != 1, "injected store observer panic");
        }
    }

    #[test]
    fn first_observer_panic_disables_following_callbacks() {
        let mut sink = PanicOnce { calls: 0 };
        let mut observer = BestEffortStoreObserver::new(&mut sink);

        observer.observe(StoreObservation::StageStarted(StoreStage::JournalOpen));
        observer.observe(StoreObservation::StageFinished(StoreStage::JournalOpen));
        observer.observe(StoreObservation::JournalPhysicalBytes(7));

        assert_eq!(sink.calls, 1);
    }
}
