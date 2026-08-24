//! Workflow state rebuilt by replaying events.

use alloc::collections::{BTreeMap, BTreeSet};
use core::fmt;

use crate::identity::{ArtifactRef, ArtifactRevision, Digest, EventId};
use crate::workflow::error::WorkflowError;
use crate::workflow::event::WorkflowEvent;
use crate::workflow::signal::{SignalKind, WorkflowSignal};

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
    /// A candidate revision identifier changed content during replay.
    CandidateConflict {
        /// Contested candidate revision.
        artifact_revision: ArtifactRevision,
    },
    /// An external artifact reference changed content during replay.
    EvidenceConflict {
        /// Contested artifact reference.
        artifact_ref: ArtifactRef,
    },
    /// A repair does not consume an available review-findings event.
    InvalidCausation {
        /// Repair event being replayed.
        event_id: EventId,
        /// Findings event it tried to consume.
        source_event_id: EventId,
    },
}

impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateEvent { event_id } => {
                write!(f, "event {event_id} appears more than once")
            }
            Self::CandidateConflict { artifact_revision } => {
                write!(
                    f,
                    "candidate {artifact_revision} has multiple content digests"
                )
            }
            Self::EvidenceConflict { artifact_ref } => {
                write!(f, "artifact {artifact_ref} has multiple content digests")
            }
            Self::InvalidCausation {
                event_id,
                source_event_id,
            } => write!(
                f,
                "repair event {event_id} cannot consume findings event {source_event_id}"
            ),
        }
    }
}

impl core::error::Error for ApplyError {}

/// Accepted signals, keyed by event id. Deterministic by construction:
/// no hashing, no clock, no ordering other than the event id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkflowState {
    accepted: BTreeMap<EventId, WorkflowSignal>,
    candidate_digests: BTreeMap<ArtifactRevision, Digest>,
    evidence_digests: BTreeMap<ArtifactRef, Digest>,
    consumed_findings: BTreeSet<EventId>,
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
                if let Err(error) = self.check_bindings(signal) {
                    return Err(match error {
                        WorkflowError::CandidateConflict { artifact_revision } => {
                            ApplyError::CandidateConflict { artifact_revision }
                        }
                        WorkflowError::EvidenceConflict { artifact_ref } => {
                            ApplyError::EvidenceConflict { artifact_ref }
                        }
                        WorkflowError::CausationUnavailable { source_event_id } => {
                            ApplyError::InvalidCausation {
                                event_id,
                                source_event_id,
                            }
                        }
                        _ => unreachable!("state binding checks return conflict or causation"),
                    });
                }
                self.candidate_digests.insert(
                    signal.artifact_revision().clone(),
                    signal.candidate_digest().clone(),
                );
                if let (Some(reference), Some(digest)) =
                    (signal.artifact_ref(), signal.evidence_digest())
                {
                    self.evidence_digests
                        .insert(reference.clone(), digest.clone());
                }
                if signal.kind() == SignalKind::RepairSubmitted {
                    self.consumed_findings.insert(
                        signal
                            .source_event_id()
                            .expect("validated repair has a source")
                            .clone(),
                    );
                }
                self.accepted.insert(event_id, signal.clone());
                Ok(())
            }
        }
    }

    pub(crate) fn check_bindings(&self, signal: &WorkflowSignal) -> Result<(), WorkflowError> {
        if let Some(existing) = self.candidate_digests.get(signal.artifact_revision())
            && existing != signal.candidate_digest()
        {
            return Err(WorkflowError::CandidateConflict {
                artifact_revision: signal.artifact_revision().clone(),
            });
        }
        if let (Some(reference), Some(digest)) = (signal.artifact_ref(), signal.evidence_digest())
            && let Some(existing) = self.evidence_digests.get(reference)
            && existing != digest
        {
            return Err(WorkflowError::EvidenceConflict {
                artifact_ref: reference.clone(),
            });
        }
        if signal.kind() == SignalKind::RepairSubmitted {
            let source_event_id = signal
                .source_event_id()
                .expect("validated repair has a source");
            let valid_source = self.accepted.get(source_event_id).is_some_and(|source| {
                source.kind() == SignalKind::ReviewFindings
                    && source.workflow_id() == signal.workflow_id()
            });
            if !valid_source || self.consumed_findings.contains(source_event_id) {
                return Err(WorkflowError::CausationUnavailable {
                    source_event_id: source_event_id.clone(),
                });
            }
        }
        Ok(())
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
