//! Workflow state rebuilt by replaying events.

use alloc::collections::BTreeMap;
use core::fmt;

use crate::identity::EventId;
use crate::workflow::event::WorkflowEvent;
use crate::workflow::signal::WorkflowSignal;

/// Why an event could not be applied. This only happens when the event
/// sequence itself is inconsistent, which the shell must surface as a
/// corrupt journal rather than hide.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApplyError {
    /// An event id was applied twice; the journal must never contain that.
    DuplicateEvent {
        /// The repeated event id.
        event_id: EventId,
    },
}

impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateEvent { event_id } => {
                write!(f, "event {event_id} appears more than once")
            }
        }
    }
}

impl core::error::Error for ApplyError {}

/// Accepted signals, keyed by event id. Deterministic by construction:
/// no hashing, no clock, no ordering other than the event id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkflowState {
    accepted: BTreeMap<EventId, WorkflowSignal>,
}

impl WorkflowState {
    /// An empty state.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuilds state from an event sequence, failing on inconsistency.
    pub fn replay<'a>(
        events: impl IntoIterator<Item = &'a WorkflowEvent>,
    ) -> Result<Self, ApplyError> {
        let mut state = Self::new();
        for event in events {
            state.apply(event)?;
        }
        Ok(state)
    }

    /// Applies one event. `State + Event -> State`.
    pub fn apply(&mut self, event: &WorkflowEvent) -> Result<(), ApplyError> {
        match event {
            WorkflowEvent::SignalAccepted { signal } => {
                let event_id = signal.event_id().clone();
                if self.accepted.contains_key(&event_id) {
                    return Err(ApplyError::DuplicateEvent { event_id });
                }
                self.accepted.insert(event_id, signal.clone());
                Ok(())
            }
        }
    }

    /// The accepted signal with this event id, if any.
    #[must_use]
    pub fn accepted(&self, event_id: &EventId) -> Option<&WorkflowSignal> {
        self.accepted.get(event_id)
    }

    /// Number of accepted signals.
    #[must_use]
    pub fn len(&self) -> usize {
        self.accepted.len()
    }

    /// Whether no signal has been accepted.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.accepted.is_empty()
    }
}
