//! An in-memory [`Journal`] with fault injection.

use std::collections::VecDeque;

use aizu_core::BoundedTimestamp;
use aizu_core::workflow::WorkflowEvent;
use aizu_engine::{Journal, JournalEntry, JournalError, MAX_JOURNAL_ENTRIES};

/// In-memory journal. Behaves like a durable store from the engine's point
/// of view, and lets tests inject the failures a real store can produce.
#[derive(Debug, Default)]
pub struct MemoryJournal {
    entries: Vec<JournalEntry>,
    load_faults: VecDeque<JournalError>,
    append_faults: VecDeque<AppendFault>,
}

/// How an injected append failure behaves.
#[derive(Clone, Debug, PartialEq, Eq)]
enum AppendFault {
    /// Fail before anything is stored.
    Reject(JournalError),
    /// Store the entry but report [`JournalError::OutcomeUnknown`], as a
    /// crash after the write but before the acknowledgement would.
    StoreThenUnknown,
}

impl MemoryJournal {
    /// An empty journal.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Makes the next `load` fail with `error`.
    pub fn fail_next_load(&mut self, error: JournalError) {
        self.load_faults.push_back(error);
    }

    /// Makes the next `append` fail before storing anything.
    pub fn fail_next_append(&mut self, error: JournalError) {
        self.append_faults.push_back(AppendFault::Reject(error));
    }

    /// Makes the next `append` store the entry but report an unknown outcome.
    pub fn lose_next_append_acknowledgement(&mut self) {
        self.append_faults.push_back(AppendFault::StoreThenUnknown);
    }

    /// Everything stored so far, in order.
    #[must_use]
    pub fn entries(&self) -> &[JournalEntry] {
        &self.entries
    }
}

impl Journal for MemoryJournal {
    fn load(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        if let Some(error) = self.load_faults.pop_front() {
            return Err(error);
        }
        if self.entries.len() > MAX_JOURNAL_ENTRIES {
            return Err(JournalError::BoundExceeded {
                max: MAX_JOURNAL_ENTRIES,
            });
        }
        Ok(self.entries.clone())
    }

    fn append(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
    ) -> Result<JournalEntry, JournalError> {
        let fault = self.append_faults.pop_front();
        if let Some(AppendFault::Reject(error)) = fault {
            return Err(error);
        }
        let entry = JournalEntry {
            seq: self.entries.len() as u64 + 1,
            at,
            event: event.clone(),
        };
        self.entries.push(entry.clone());
        if fault == Some(AppendFault::StoreThenUnknown) {
            return Err(JournalError::OutcomeUnknown {
                detail: "acknowledgement lost after the write".to_owned(),
            });
        }
        Ok(entry)
    }
}
