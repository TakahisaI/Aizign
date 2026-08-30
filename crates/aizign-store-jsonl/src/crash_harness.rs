//! Crate-internal process-crash evidence for the store-v2 publication path.
//!
//! This module is deliberately kept behind `cfg(test)`.  It is not a second
//! store implementation and it does not add a public test hook: the helper
//! process calls the ordinary writer/reader entry points and the production
//! durability adapter reports completed primitives back to this module.
//!
//! The names in [`SCENARIOS`] and [`MUTATION_SENTINELS`] are a closed evidence
//! manifest.  They are intentionally boring strings.  Keeping the manifest
//! here (rather than deriving it from a test function name) makes omissions,
//! duplicate execution, and accidental widening visible to the parent.

#![cfg(all(
    test,
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead as _, BufReader, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use aizign_core::workflow::{Command, WorkflowEvent};
use aizign_engine::{Journal, JournalError, JournalReader, SignalOutcome};
use aizign_testkit::{FixedClock, TempDir, signals};
use serde::{Deserialize, Serialize};

use crate::commit::{CommitPoint, hash_bytes};
use crate::durability::{DurabilityPoint, PrimitiveEvent};
use crate::journal::{
    COMMIT_FILE_NAME, JOURNAL_FILE_NAME, JsonlJournal, JsonlJournalReader, LOCK_FILE_NAME,
    PUBLISH_FILE_NAME,
};
use crate::publish::PublishWitness;

const MODE_ENV: &str = "AIZIGN_STORE_CRASH_MODE";
const CASE_ENV: &str = "AIZIGN_STORE_CRASH_CASE";
const STATE_ENV: &str = "AIZIGN_STORE_CRASH_STATE";
const ROLE_ENV: &str = "AIZIGN_STORE_CRASH_ROLE";
const MODE: &str = "helper-v1";
/// The acknowledgement bytes are intentionally not sent through a buffered
/// writer.  They are a separate stderr stream from the stdout control line.
pub(crate) const ACK: &[u8; 26] = b"AIZIGN_STORE_CRASH_ACK_V1\n";
const CHILD_TIMEOUT: Duration = Duration::from_secs(10);
const MATRIX_TIMEOUT: Duration = Duration::from_mins(4);
const MAX_ARTIFACT_BYTES: u64 = 1024 * 1024;
const STORE_AUTHORITY: &str = include_str!("../../../spec/store/v2/README.md");
const CLASSIFICATION_AUTHORITY: &str =
    include_str!("../../../spec/classification/current-operations.json");
const RECONCILIATION_AUTHORITY: &str =
    include_str!("../../../docs/adr/0013-add-bounded-read-only-workflow-signal-reconciliation.md");
const DURABILITY_SOURCE: &str = include_str!("durability.rs");
const JOURNAL_SOURCE: &str = include_str!("journal.rs");

/// The exact required process-crash scenario manifest (61 rows).
pub(crate) const SCENARIOS: &[Scenario] = &[
    Scenario::new(
        "init-state-directory-create",
        "initialize",
        "create-complete",
        "state-directory",
        1,
        None,
        "holder",
        "I0",
    ),
    Scenario::new(
        "init-state-directory-permissions",
        "initialize",
        "permissions-normalized",
        "state-directory",
        1,
        None,
        "holder",
        "I0",
    ),
    Scenario::new(
        "init-state-directory-barrier",
        "initialize",
        "directory-barrier-complete",
        "state-directory",
        1,
        None,
        "holder",
        "I0",
    ),
    Scenario::new(
        "init-parent-directory-barrier",
        "initialize",
        "directory-barrier-complete",
        "parent-directory",
        1,
        None,
        "holder",
        "I0",
    ),
    Scenario::new(
        "init-lock-create-open",
        "initialize",
        "open-complete",
        "lock",
        1,
        None,
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-lock-permissions",
        "initialize",
        "permissions-normalized",
        "lock",
        1,
        None,
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-writer-lock-acquired",
        "initialize",
        "lock-acquired",
        "lock",
        1,
        None,
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-journal-create-open",
        "initialize",
        "open-complete",
        "journal",
        1,
        None,
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-journal-permissions",
        "initialize",
        "permissions-normalized",
        "journal",
        1,
        None,
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-lock-barrier",
        "initialize",
        "file-barrier-complete",
        "lock",
        1,
        None,
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-journal-barrier",
        "initialize",
        "file-barrier-complete",
        "journal",
        1,
        None,
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-initial-namespace-barrier",
        "initialize",
        "directory-barrier-complete",
        "state-directory",
        2,
        None,
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-commit-temporary-create-open",
        "initialize",
        "open-complete",
        "commit-temporary",
        1,
        None,
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-commit-temporary-permissions",
        "initialize",
        "permissions-normalized",
        "commit-temporary",
        1,
        None,
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-commit-temporary-write",
        "initialize",
        "write-complete",
        "commit-temporary",
        1,
        Some(DurabilityPoint::CommitTemporaryWriteComplete),
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-commit-temporary-barrier",
        "initialize",
        "file-barrier-complete",
        "commit-temporary",
        1,
        Some(DurabilityPoint::CommitTemporaryBarrierComplete),
        "holder",
        "I1",
    ),
    Scenario::new(
        "init-commit-rename",
        "initialize",
        "rename-complete",
        "commit",
        1,
        Some(DurabilityPoint::CommitRenameComplete),
        "holder",
        "I2",
    ),
    Scenario::new(
        "init-commit-directory-barrier",
        "initialize",
        "directory-barrier-complete",
        "state-directory",
        3,
        Some(DurabilityPoint::CommitDirectoryBarrierComplete),
        "holder",
        "I2",
    ),
    Scenario::new(
        "init-publish-witness-create-open",
        "initialize",
        "open-complete",
        "publish-witness",
        1,
        None,
        "holder",
        "I3",
    ),
    Scenario::new(
        "init-publish-witness-permissions",
        "initialize",
        "permissions-normalized",
        "publish-witness",
        1,
        None,
        "holder",
        "I3",
    ),
    Scenario::new(
        "init-prepared-write",
        "initialize",
        "write-complete",
        "publish-witness",
        1,
        Some(DurabilityPoint::PreparedWriteComplete),
        "holder",
        "I4",
    ),
    Scenario::new(
        "init-prepared-barrier",
        "initialize",
        "file-barrier-complete",
        "publish-witness",
        1,
        Some(DurabilityPoint::PreparedBarrierComplete),
        "holder",
        "I4",
    ),
    Scenario::new(
        "init-publish-witness-directory-barrier",
        "initialize",
        "directory-barrier-complete",
        "state-directory",
        4,
        None,
        "holder",
        "I4",
    ),
    Scenario::new(
        "init-clean-write",
        "initialize",
        "write-complete",
        "publish-witness",
        2,
        Some(DurabilityPoint::CleanWriteComplete),
        "holder",
        "I5",
    ),
    Scenario::new(
        "init-clean-barrier",
        "initialize",
        "file-barrier-complete",
        "publish-witness",
        2,
        Some(DurabilityPoint::CleanBarrierComplete),
        "holder",
        "I5",
    ),
    Scenario::normal("init-normal-exit", "initialize", "I5"),
    Scenario::new(
        "resume-writer-lock-acquired",
        "reopen-submit",
        "lock-acquired",
        "lock",
        1,
        None,
        "holder",
        "I4",
    ),
    Scenario::new(
        "resume-prepared-rebarrier",
        "reopen-submit",
        "file-barrier-complete",
        "publish-witness",
        1,
        Some(DurabilityPoint::PreparedBarrierComplete),
        "holder",
        "I4",
    ),
    Scenario::new(
        "resume-publish-witness-directory-barrier",
        "reopen-submit",
        "directory-barrier-complete",
        "state-directory",
        1,
        None,
        "holder",
        "I4",
    ),
    Scenario::new(
        "resume-clean-write",
        "reopen-submit",
        "write-complete",
        "publish-witness",
        1,
        Some(DurabilityPoint::CleanWriteComplete),
        "holder",
        "I5",
    ),
    Scenario::new(
        "resume-clean-barrier",
        "reopen-submit",
        "file-barrier-complete",
        "publish-witness",
        1,
        Some(DurabilityPoint::CleanBarrierComplete),
        "holder",
        "I5",
    ),
    Scenario::normal("resume-normal-exit", "reopen-submit", "I5"),
    Scenario::new(
        "append-writer-lock-acquired",
        "append",
        "lock-acquired",
        "lock",
        1,
        None,
        "holder",
        "A0",
    ),
    Scenario::new(
        "append-prepared-write",
        "append",
        "write-complete",
        "publish-witness",
        1,
        Some(DurabilityPoint::PreparedWriteComplete),
        "holder",
        "A1",
    ),
    Scenario::new(
        "append-prepared-barrier",
        "append",
        "file-barrier-complete",
        "publish-witness",
        1,
        Some(DurabilityPoint::PreparedBarrierComplete),
        "holder",
        "A1",
    ),
    Scenario::partial("append-journal-partial-1", 1),
    Scenario::partial("append-journal-partial-half", 2),
    Scenario::partial("append-journal-partial-last-minus-one", 3),
    Scenario::new(
        "append-journal-write",
        "append",
        "write-complete",
        "journal",
        1,
        Some(DurabilityPoint::JournalRecordWriteComplete),
        "holder",
        "A1",
    ),
    Scenario::new(
        "append-journal-barrier",
        "append",
        "file-barrier-complete",
        "journal",
        1,
        Some(DurabilityPoint::JournalBarrierComplete),
        "holder",
        "A1",
    ),
    Scenario::new(
        "append-commit-temporary-create-open",
        "append",
        "open-complete",
        "commit-temporary",
        1,
        None,
        "holder",
        "A1",
    ),
    Scenario::new(
        "append-commit-temporary-permissions",
        "append",
        "permissions-normalized",
        "commit-temporary",
        1,
        None,
        "holder",
        "A1",
    ),
    Scenario::new(
        "append-commit-temporary-write",
        "append",
        "write-complete",
        "commit-temporary",
        1,
        Some(DurabilityPoint::CommitTemporaryWriteComplete),
        "holder",
        "A1",
    ),
    Scenario::new(
        "append-commit-temporary-barrier",
        "append",
        "file-barrier-complete",
        "commit-temporary",
        1,
        Some(DurabilityPoint::CommitTemporaryBarrierComplete),
        "holder",
        "A1",
    ),
    Scenario::new(
        "append-commit-rename",
        "append",
        "rename-complete",
        "commit",
        1,
        Some(DurabilityPoint::CommitRenameComplete),
        "holder",
        "A2",
    ),
    Scenario::new(
        "append-commit-directory-barrier",
        "append",
        "directory-barrier-complete",
        "state-directory",
        1,
        Some(DurabilityPoint::CommitDirectoryBarrierComplete),
        "holder",
        "A2",
    ),
    Scenario::new(
        "append-clean-write",
        "append",
        "write-complete",
        "publish-witness",
        2,
        Some(DurabilityPoint::CleanWriteComplete),
        "holder",
        "A3",
    ),
    Scenario::new(
        "append-clean-barrier",
        "append",
        "file-barrier-complete",
        "publish-witness",
        2,
        Some(DurabilityPoint::CleanBarrierComplete),
        "holder",
        "A3",
    ),
    Scenario::new(
        "append-durable-before-response-write",
        "append",
        "durable-append-complete",
        "journal",
        1,
        Some(DurabilityPoint::DurableAppendComplete),
        "response-child",
        "A3",
    ),
    Scenario::new(
        "response-after-write",
        "response",
        "response-write-complete",
        "response",
        1,
        None,
        "response-child",
        "A3",
    ),
    Scenario::new(
        "response-after-flush",
        "response",
        "response-flush-complete",
        "response",
        1,
        None,
        "response-child",
        "A3",
    ),
    Scenario::normal_response("response-normal-exit"),
    Scenario::new(
        "concurrency-reader-at-prepared",
        "append",
        "file-barrier-complete",
        "publish-witness",
        1,
        Some(DurabilityPoint::PreparedBarrierComplete),
        "holder",
        "C1",
    ),
    Scenario::new(
        "concurrency-reader-at-journal",
        "append",
        "file-barrier-complete",
        "journal",
        1,
        Some(DurabilityPoint::JournalBarrierComplete),
        "holder",
        "C1",
    ),
    Scenario::new(
        "concurrency-reader-at-commit-namespace",
        "append",
        "directory-barrier-complete",
        "state-directory",
        1,
        Some(DurabilityPoint::CommitDirectoryBarrierComplete),
        "holder",
        "C2",
    ),
    Scenario::new(
        "concurrency-reader-at-clean",
        "append",
        "file-barrier-complete",
        "publish-witness",
        2,
        Some(DurabilityPoint::CleanBarrierComplete),
        "holder",
        "C3",
    ),
    Scenario::new(
        "concurrency-same-event-submit",
        "append",
        "lock-acquired",
        "lock",
        1,
        None,
        "holder",
        "C4",
    ),
    Scenario::new(
        "concurrency-different-event-submit",
        "append",
        "lock-acquired",
        "lock",
        1,
        None,
        "holder",
        "C5",
    ),
    Scenario::new(
        "concurrency-reconcile-under-writer",
        "append",
        "lock-acquired",
        "lock",
        1,
        None,
        "holder",
        "C6",
    ),
    Scenario::new(
        "concurrency-submit-under-reader",
        "reopen-read",
        "lock-acquired",
        "lock",
        1,
        None,
        "holder",
        "C7",
    ),
    Scenario::partial_custom("concurrency-writer-after-partial-tail"),
];

/// The exact mutation sentinel manifest (nine rows).
pub(crate) const MUTATION_SENTINELS: &[&str] = &[
    "mutation-prepared-barrier-noop",
    "mutation-journal-barrier-noop",
    "mutation-commit-temporary-barrier-noop",
    "mutation-commit-directory-barrier-noop",
    "mutation-clean-barrier-noop",
    "mutation-commit-before-journal-barrier",
    "mutation-reader-accepts-incomplete-generation",
    "mutation-tail-repair-or-promotion",
    "mutation-append-revalidation-bypass",
];

/// One closed row of the process evidence manifest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Scenario {
    pub(crate) id: &'static str,
    pub(crate) phase: &'static str,
    pub(crate) operation: &'static str,
    pub(crate) artifact: &'static str,
    pub(crate) occurrence: u8,
    pub(crate) durability_point: Option<DurabilityPoint>,
    pub(crate) actor: &'static str,
    pub(crate) result: &'static str,
    pub(crate) partial_kind: Option<u8>,
    pub(crate) normal_exit: bool,
}

impl Scenario {
    #[allow(clippy::too_many_arguments)]
    const fn new(
        id: &'static str,
        phase: &'static str,
        operation: &'static str,
        artifact: &'static str,
        occurrence: u8,
        durability_point: Option<DurabilityPoint>,
        actor: &'static str,
        result: &'static str,
    ) -> Self {
        Self {
            id,
            phase,
            operation,
            artifact,
            occurrence,
            durability_point,
            actor,
            result,
            partial_kind: None,
            normal_exit: false,
        }
    }

    const fn partial(id: &'static str, kind: u8) -> Self {
        Self {
            id,
            phase: "append",
            operation: "partial-write-stopped",
            artifact: "journal",
            occurrence: 1,
            durability_point: None,
            actor: "holder",
            result: "A1",
            partial_kind: Some(kind),
            normal_exit: false,
        }
    }

    const fn partial_custom(id: &'static str) -> Self {
        Self {
            id,
            phase: "append",
            operation: "partial-write-stopped",
            artifact: "journal",
            occurrence: 1,
            durability_point: None,
            actor: "holder",
            result: "C8",
            partial_kind: Some(2),
            normal_exit: false,
        }
    }

    const fn normal(id: &'static str, phase: &'static str, result: &'static str) -> Self {
        Self {
            id,
            phase,
            operation: "process-exit-observed",
            artifact: "response",
            occurrence: 1,
            durability_point: None,
            actor: "parent-observed-exit",
            result,
            partial_kind: None,
            normal_exit: true,
        }
    }

    const fn normal_response(id: &'static str) -> Self {
        Self {
            id,
            phase: "response",
            operation: "process-exit-observed",
            artifact: "response",
            occurrence: 1,
            durability_point: None,
            actor: "parent-observed-exit",
            result: "A3",
            partial_kind: None,
            normal_exit: true,
        }
    }

    fn is_concurrency(self) -> bool {
        self.id.starts_with("concurrency-")
    }

    fn is_response(self) -> bool {
        self.phase == "response" || self.id == "append-durable-before-response-write"
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageProjection {
    Error(&'static str),
    Known { entries: usize },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SubmitProjection {
    NotApplicable,
    Accepted,
    Duplicate,
    Error(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MutationProjection {
    None,
    FreshInitialization,
    WitnessInitialization,
    PreparedResume,
    OrdinaryAppend,
}

/// The closed per-image result records from Issue #82 A1/A2.  This is an
/// executable projection of the store authority, not a second state machine:
/// the inspector consumes every field while the named `spec/store/v2` sections
/// remain the normative source of the rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ResultExpectation {
    code: &'static str,
    reader: ImageProjection,
    reconcile: ImageProjection,
    same_submit: SubmitProjection,
    next_submit: SubmitProjection,
    mutation: MutationProjection,
    equality_required: bool,
    authority: &'static str,
}

const RESULT_EXPECTATIONS: &[ResultExpectation; 18] = &[
    ResultExpectation {
        code: "I0",
        reader: ImageProjection::Error("JOURNAL_UNAVAILABLE"),
        reconcile: ImageProjection::Error("JOURNAL_UNAVAILABLE"),
        same_submit: SubmitProjection::Accepted,
        next_submit: SubmitProjection::Accepted,
        mutation: MutationProjection::FreshInitialization,
        equality_required: true,
        authority: "Zero-entry initialization",
    },
    ResultExpectation {
        code: "I1",
        reader: ImageProjection::Error("JOURNAL_UNAVAILABLE"),
        reconcile: ImageProjection::Error("JOURNAL_UNAVAILABLE"),
        same_submit: SubmitProjection::Error("JOURNAL_UNAVAILABLE"),
        next_submit: SubmitProjection::Error("JOURNAL_UNAVAILABLE"),
        mutation: MutationProjection::None,
        equality_required: true,
        authority: "Zero-entry initialization",
    },
    ResultExpectation {
        code: "I2",
        reader: ImageProjection::Error("JOURNAL_UNAVAILABLE"),
        reconcile: ImageProjection::Error("JOURNAL_UNAVAILABLE"),
        same_submit: SubmitProjection::Accepted,
        next_submit: SubmitProjection::Accepted,
        mutation: MutationProjection::WitnessInitialization,
        equality_required: true,
        authority: "Zero-entry initialization; Existing-image matrix",
    },
    ResultExpectation {
        code: "I3",
        reader: ImageProjection::Error("JOURNAL_CORRUPT"),
        reconcile: ImageProjection::Error("JOURNAL_CORRUPT"),
        same_submit: SubmitProjection::Error("JOURNAL_CORRUPT"),
        next_submit: SubmitProjection::Error("JOURNAL_CORRUPT"),
        mutation: MutationProjection::None,
        equality_required: true,
        authority: "Artifact set and physical rules; Existing-image matrix",
    },
    ResultExpectation {
        code: "I4",
        reader: ImageProjection::Error("JOURNAL_UNAVAILABLE"),
        reconcile: ImageProjection::Error("JOURNAL_UNAVAILABLE"),
        same_submit: SubmitProjection::Accepted,
        next_submit: SubmitProjection::Accepted,
        mutation: MutationProjection::PreparedResume,
        equality_required: true,
        authority: "Zero-entry initialization",
    },
    ResultExpectation {
        code: "I5",
        reader: ImageProjection::Known { entries: 0 },
        reconcile: ImageProjection::Known { entries: 0 },
        same_submit: SubmitProjection::Accepted,
        next_submit: SubmitProjection::Accepted,
        mutation: MutationProjection::OrdinaryAppend,
        equality_required: true,
        authority: "Clean authority; Bounded visible-CLEAN exception",
    },
    ResultExpectation {
        code: "A0",
        reader: ImageProjection::Known { entries: 0 },
        reconcile: ImageProjection::Known { entries: 0 },
        same_submit: SubmitProjection::Accepted,
        next_submit: SubmitProjection::Accepted,
        mutation: MutationProjection::OrdinaryAppend,
        equality_required: true,
        authority: "Clean authority; Append publication order",
    },
    ResultExpectation {
        code: "A1",
        reader: ImageProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        reconcile: ImageProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        same_submit: SubmitProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        next_submit: SubmitProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        mutation: MutationProjection::None,
        equality_required: true,
        authority: "Append publication order; Existing-image matrix",
    },
    ResultExpectation {
        code: "A2",
        reader: ImageProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        reconcile: ImageProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        same_submit: SubmitProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        next_submit: SubmitProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        mutation: MutationProjection::None,
        equality_required: true,
        authority: "Append publication order; Existing-image matrix",
    },
    ResultExpectation {
        code: "A3",
        reader: ImageProjection::Known { entries: 1 },
        reconcile: ImageProjection::Known { entries: 1 },
        same_submit: SubmitProjection::Duplicate,
        next_submit: SubmitProjection::Accepted,
        mutation: MutationProjection::OrdinaryAppend,
        equality_required: true,
        authority: "Clean authority; Bounded visible-CLEAN exception",
    },
    ResultExpectation {
        code: "C1",
        reader: ImageProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        reconcile: ImageProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        same_submit: SubmitProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        next_submit: SubmitProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        mutation: MutationProjection::None,
        equality_required: true,
        authority: "Append publication order; Existing-image matrix",
    },
    ResultExpectation {
        code: "C2",
        reader: ImageProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        reconcile: ImageProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        same_submit: SubmitProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        next_submit: SubmitProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        mutation: MutationProjection::None,
        equality_required: true,
        authority: "Append publication order; Existing-image matrix",
    },
    ResultExpectation {
        code: "C3",
        reader: ImageProjection::Known { entries: 1 },
        reconcile: ImageProjection::Known { entries: 1 },
        same_submit: SubmitProjection::Duplicate,
        next_submit: SubmitProjection::Accepted,
        mutation: MutationProjection::OrdinaryAppend,
        equality_required: true,
        authority: "Clean authority; Bounded visible-CLEAN exception",
    },
    ResultExpectation {
        code: "C4",
        reader: ImageProjection::Known { entries: 1 },
        reconcile: ImageProjection::Known { entries: 1 },
        same_submit: SubmitProjection::Duplicate,
        next_submit: SubmitProjection::NotApplicable,
        mutation: MutationProjection::OrdinaryAppend,
        equality_required: true,
        authority: "Clean authority; Append publication order",
    },
    ResultExpectation {
        code: "C5",
        reader: ImageProjection::Known { entries: 1 },
        reconcile: ImageProjection::Known { entries: 1 },
        same_submit: SubmitProjection::Duplicate,
        next_submit: SubmitProjection::Accepted,
        mutation: MutationProjection::OrdinaryAppend,
        equality_required: true,
        authority: "Clean authority; Append publication order",
    },
    ResultExpectation {
        code: "C6",
        reader: ImageProjection::Known { entries: 0 },
        reconcile: ImageProjection::Known { entries: 0 },
        same_submit: SubmitProjection::Accepted,
        next_submit: SubmitProjection::Accepted,
        mutation: MutationProjection::None,
        equality_required: true,
        authority: "Clean authority; ADR-0013 non-blocking shared/exclusive lock boundary",
    },
    ResultExpectation {
        code: "C7",
        reader: ImageProjection::Known { entries: 0 },
        reconcile: ImageProjection::Known { entries: 0 },
        same_submit: SubmitProjection::Accepted,
        next_submit: SubmitProjection::Accepted,
        mutation: MutationProjection::OrdinaryAppend,
        equality_required: true,
        authority: "Clean authority; ADR-0013 non-blocking shared/exclusive lock boundary",
    },
    ResultExpectation {
        code: "C8",
        reader: ImageProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        reconcile: ImageProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        same_submit: SubmitProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        next_submit: SubmitProjection::Error("JOURNAL_OUTCOME_UNKNOWN"),
        mutation: MutationProjection::None,
        equality_required: true,
        authority: "Append publication order; Existing-image matrix",
    },
];

fn result_expectation(scenario: &Scenario) -> &'static ResultExpectation {
    RESULT_EXPECTATIONS
        .iter()
        .find(|expectation| expectation.code == scenario.result)
        .unwrap_or_else(|| panic!("scenario {} has no closed result record", scenario.id))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Holder,
    ResponseChild,
    Inspector,
    Contender,
}

impl Role {
    fn parse(value: &str) -> io::Result<Self> {
        match value {
            "holder" => Ok(Self::Holder),
            "response-child" => Ok(Self::ResponseChild),
            "inspector" => Ok(Self::Inspector),
            "contender" => Ok(Self::Contender),
            _ => Err(invalid_helper("unknown helper role")),
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Holder => "holder",
            Self::ResponseChild => "response-child",
            Self::Inspector => "inspector",
            Self::Contender => "contender",
        }
    }
}

#[derive(Clone, Debug)]
struct HelperConfig {
    scenario: &'static Scenario,
    role: Role,
    state: PathBuf,
}

impl HelperConfig {
    fn from_environment() -> io::Result<Self> {
        for (key, _) in std::env::vars_os() {
            let key = key.to_string_lossy();
            if key.starts_with("AIZIGN_STORE_CRASH_")
                && !matches!(key.as_ref(), MODE_ENV | CASE_ENV | STATE_ENV | ROLE_ENV)
            {
                return Err(invalid_helper("unknown helper environment key"));
            }
        }
        let mode = std::env::var(MODE_ENV).map_err(|_| invalid_helper("missing helper mode"))?;
        if mode != MODE {
            return Err(invalid_helper("unsupported helper mode"));
        }
        let id = std::env::var(CASE_ENV).map_err(|_| invalid_helper("missing helper case"))?;
        let scenario = SCENARIOS
            .iter()
            .find(|scenario| scenario.id == id)
            .ok_or_else(|| invalid_helper("unknown helper case"))?;
        let state = std::env::var_os(STATE_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| invalid_helper("missing helper state"))?;
        if state.to_string_lossy().contains(['\r', '\n']) {
            return Err(invalid_helper("helper state contains a line break"));
        }
        let role_value =
            std::env::var(ROLE_ENV).map_err(|_| invalid_helper("missing helper role"))?;
        let role = Role::parse(&role_value)?;
        validate_role_pair(scenario, role)?;
        Ok(Self {
            scenario,
            role,
            state,
        })
    }
}

fn invalid_helper(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn validate_role_pair(scenario: &Scenario, role: Role) -> io::Result<()> {
    let valid = if scenario.id == "append-durable-before-response-write" {
        matches!(role, Role::ResponseChild | Role::Inspector)
    } else if scenario.phase == "response" {
        matches!(role, Role::ResponseChild | Role::Inspector)
    } else if scenario.is_concurrency() {
        matches!(role, Role::Holder | Role::Contender | Role::Inspector)
    } else {
        matches!(role, Role::Holder | Role::Inspector)
    };
    if valid {
        Ok(())
    } else {
        Err(invalid_helper(
            "scenario/role pair is not in the closed matrix",
        ))
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyRecord {
    record_type: &'static str,
    harness_version: u64,
    case_id: &'static str,
    phase: &'static str,
    operation: &'static str,
    artifact: &'static str,
    occurrence: u8,
    durability_point: Option<&'static str>,
    byte_count: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedReadyRecord {
    record_type: String,
    harness_version: u64,
    case_id: String,
    phase: String,
    operation: String,
    artifact: String,
    occurrence: u8,
    durability_point: Option<String>,
    byte_count: Option<usize>,
}

const READY_RECORD_KEYS: &[&str] = &[
    "recordType",
    "harnessVersion",
    "caseId",
    "phase",
    "operation",
    "artifact",
    "occurrence",
    "durabilityPoint",
    "byteCount",
];

#[derive(Default)]
struct Controller {
    config: Option<HelperConfig>,
    counts: BTreeMap<(&'static str, &'static str), u8>,
    selected: bool,
    enabled: bool,
}

static CONTROLLER: OnceLock<Mutex<Controller>> = OnceLock::new();

fn controller() -> &'static Mutex<Controller> {
    CONTROLLER.get_or_init(|| {
        Mutex::new(Controller {
            config: None,
            counts: BTreeMap::new(),
            selected: false,
            enabled: true,
        })
    })
}

fn lock_controller() -> io::Result<std::sync::MutexGuard<'static, Controller>> {
    controller()
        .lock()
        .map_err(|_| io::Error::other("crash controller mutex poisoned"))
}

fn load_config(controller: &mut Controller) -> io::Result<Option<()>> {
    if controller.config.is_some() {
        return Ok(Some(()));
    }
    if std::env::var(MODE_ENV).ok().as_deref() != Some(MODE) {
        return Ok(None);
    }
    controller.config = Some(HelperConfig::from_environment()?);
    Ok(Some(()))
}

/// Reset occurrence counts after a child has prepared its clean fixture.  The
/// setup open is intentionally outside the selected append phase.
fn reset_phase() -> io::Result<()> {
    let mut state = lock_controller()?;
    state.counts.clear();
    state.selected = false;
    Ok(())
}

fn with_controller_disabled<T>(operation: impl FnOnce() -> T) -> io::Result<T> {
    let previous = {
        let mut state = lock_controller()?;
        let previous = state.enabled;
        state.enabled = false;
        previous
    };
    let result = operation();
    let mut state = lock_controller()?;
    state.enabled = previous;
    Ok(result)
}

fn selected_actor(role: Role, scenario: &Scenario) -> bool {
    role.name() == scenario.actor
}

fn durability_point_name(point: Option<DurabilityPoint>) -> Option<&'static str> {
    Some(match point? {
        DurabilityPoint::PreparedWriteComplete => "PreparedWriteComplete",
        DurabilityPoint::PreparedBarrierComplete => "PreparedBarrierComplete",
        DurabilityPoint::JournalRecordWriteComplete => "JournalRecordWriteComplete",
        DurabilityPoint::JournalBarrierComplete => "JournalBarrierComplete",
        DurabilityPoint::CommitTemporaryWriteComplete => "CommitTemporaryWriteComplete",
        DurabilityPoint::CommitTemporaryBarrierComplete => "CommitTemporaryBarrierComplete",
        DurabilityPoint::CommitRenameComplete => "CommitRenameComplete",
        DurabilityPoint::CommitDirectoryBarrierComplete => "CommitDirectoryBarrierComplete",
        DurabilityPoint::CleanWriteComplete => "CleanWriteComplete",
        DurabilityPoint::CleanBarrierComplete => "CleanBarrierComplete",
        DurabilityPoint::DurableAppendComplete => "DurableAppendComplete",
    })
}

fn write_ready(
    scenario: &Scenario,
    operation: &'static str,
    artifact: &'static str,
    occurrence: u8,
    point: Option<DurabilityPoint>,
    byte_count: Option<usize>,
) -> io::Result<()> {
    let record = ReadyRecord {
        record_type: "ready",
        harness_version: 1,
        case_id: scenario.id,
        phase: scenario.phase,
        operation,
        artifact,
        occurrence,
        durability_point: durability_point_name(point),
        byte_count,
    };
    let mut bytes = serde_json::to_vec(&record)
        .map_err(|error| io::Error::other(format!("ready record serialization failed: {error}")))?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&bytes)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    bytes.fill(0);
    Ok(())
}

fn wait_for_release() -> io::Result<()> {
    let mut byte = [0_u8; 1];
    io::stdin().read_exact(&mut byte)?;
    if byte[0] != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "helper release token is not the exact one-byte release",
        ));
    }
    Ok(())
}

/// Called by the production adapter after a real primitive has completed.
/// This is the only control point used by the helper child.
pub(crate) fn primitive_completed(event: PrimitiveEvent) -> io::Result<()> {
    let selected = {
        let mut state = lock_controller()?;
        if load_config(&mut state)?.is_none() || !state.enabled {
            return Ok(());
        }
        let (role, scenario) = {
            let config = state.config.as_ref().expect("loaded helper config");
            (config.role, config.scenario)
        };
        let count = state
            .counts
            .entry((event.operation, event.artifact))
            .or_insert(0);
        *count = count.saturating_add(1);
        let occurrence = *count;
        if state.selected || !selected_actor(role, scenario) {
            return Ok(());
        }
        if event.operation != scenario.operation
            || event.artifact != scenario.artifact
            || occurrence != scenario.occurrence
        {
            return Ok(());
        }
        if event.durability_point != scenario.durability_point {
            return Err(io::Error::other(
                "completed event has the wrong durability point",
            ));
        }
        if event.byte_count.is_some() != scenario.partial_kind.is_some() {
            return Err(io::Error::other(
                "completed event has the wrong byte-count presence",
            ));
        }
        if scenario.partial_kind.is_some() && event.byte_count == Some(0) {
            return Err(io::Error::other(
                "partial completed event has zero byte count",
            ));
        }
        state.selected = true;
        (scenario, occurrence, event)
    };

    let (scenario, occurrence, event) = selected;
    write_ready(
        scenario,
        event.operation,
        event.artifact,
        occurrence,
        event.durability_point,
        event.byte_count,
    )?;
    wait_for_release()
}

/// Called by the production adapter immediately before a journal append.  A
/// `Some(prefix)` tells the adapter to write exactly the prefix and then emit
/// the `partial-write-stopped` event through [`primitive_completed`].
pub(crate) fn selected_partial_write(length: usize) -> io::Result<Option<usize>> {
    let mut state = lock_controller()?;
    if load_config(&mut state)?.is_none() || !state.enabled {
        return Ok(None);
    }
    let config = state.config.as_ref().expect("loaded helper config");
    if config.role != Role::Holder {
        return Ok(None);
    }
    let Some(kind) = config.scenario.partial_kind else {
        return Ok(None);
    };
    if length <= 2 {
        return Err(io::Error::other(
            "partial-write helper received an invalid record length",
        ));
    }
    let prefix = match kind {
        1 => 1,
        2 => length / 2,
        3 => length - 1,
        _ => return Err(io::Error::other("unknown partial-write case")),
    };
    if prefix == 0 || prefix >= length {
        return Err(io::Error::other(
            "partial-write prefix is outside the record",
        ));
    }
    Ok(Some(prefix))
}

fn event(id: &'static str) -> WorkflowEvent {
    WorkflowEvent::SignalAccepted {
        signal: signals::implementation_ready(id),
    }
}

fn prepare_clean_state(state: &Path) -> Result<(), JournalError> {
    let opened =
        with_controller_disabled(|| JsonlJournal::open(state).map(drop)).map_err(|error| {
            JournalError::Unavailable {
                detail: format!("crash controller setup failed: {error}"),
            }
        })?;
    opened?;
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn prepare_resume_state(state: &Path) -> Result<(), JournalError> {
    fs::create_dir_all(state).map_err(|error| JournalError::Unavailable {
        detail: format!("cannot create resume fixture: {error}"),
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(state, fs::Permissions::from_mode(0o700)).map_err(|error| {
            JournalError::Unavailable {
                detail: format!("cannot normalize resume fixture: {error}"),
            }
        })?;
    }
    write_private(&state.join(LOCK_FILE_NAME), &[]).map_err(|error| JournalError::Unavailable {
        detail: format!("cannot create resume lock: {error}"),
    })?;
    write_private(&state.join(JOURNAL_FILE_NAME), &[]).map_err(|error| {
        JournalError::Unavailable {
            detail: format!("cannot create resume journal: {error}"),
        }
    })?;
    write_private(
        &state.join(COMMIT_FILE_NAME),
        &CommitPoint::empty().encode(),
    )
    .map_err(|error| JournalError::Unavailable {
        detail: format!("cannot create resume commit: {error}"),
    })?;
    write_private(
        &state.join(PUBLISH_FILE_NAME),
        &PublishWitness::initializing().encode(),
    )
    .map_err(|error| JournalError::Unavailable {
        detail: format!("cannot create resume witness: {error}"),
    })?;
    Ok(())
}

fn run_primary(config: &HelperConfig) -> Result<(), JournalError> {
    let scenario = config.scenario;
    if scenario.phase == "initialize" {
        let journal = JsonlJournal::open(&config.state)?;
        if scenario.normal_exit {
            return Ok(());
        }
        drop(journal);
        return Err(JournalError::OutcomeUnknown {
            detail: "selected initialization event was not observed".to_owned(),
        });
    }
    if scenario.phase == "reopen-submit" {
        prepare_resume_state(&config.state)?;
        reset_phase().map_err(|error| JournalError::Unavailable {
            detail: error.to_string(),
        })?;
        let journal = JsonlJournal::open(&config.state)?;
        if scenario.normal_exit {
            return Ok(());
        }
        drop(journal);
        return Err(JournalError::OutcomeUnknown {
            detail: "selected resume event was not observed".to_owned(),
        });
    }
    if scenario.id == "concurrency-submit-under-reader" {
        prepare_clean_state(&config.state)?;
        reset_phase().map_err(|error| JournalError::Unavailable {
            detail: error.to_string(),
        })?;
        let mut reader = JsonlJournalReader::open(&config.state)?;
        let _ = reader.load_committed()?;
        write_ready(scenario, "lock-acquired", "lock", 1, None, None).map_err(|error| {
            JournalError::Unavailable {
                detail: error.to_string(),
            }
        })?;
        wait_for_release().map_err(|error| JournalError::Unavailable {
            detail: error.to_string(),
        })?;
        return Ok(());
    }
    if scenario.phase == "append" || scenario.id == "append-durable-before-response-write" {
        prepare_clean_state(&config.state)?;
        reset_phase().map_err(|error| JournalError::Unavailable {
            detail: error.to_string(),
        })?;
        let mut journal = JsonlJournal::open(&config.state)?;
        if scenario.result == "C6" {
            // C6 is the pure reconcile-under-writer schedule: the holder
            // owns the clean writer lock but deliberately performs no append.
            return Ok(());
        }
        journal.append(&event("evt-same"), signals::at(0))?;
        if scenario.is_response() {
            response_boundary(scenario, &mut journal)?;
            return Ok(());
        }
        if scenario.normal_exit {
            return Ok(());
        }
        Err(JournalError::OutcomeUnknown {
            detail: "selected append event was not observed".to_owned(),
        })
    } else if scenario.phase == "response" {
        prepare_clean_state(&config.state)?;
        reset_phase().map_err(|error| JournalError::Unavailable {
            detail: error.to_string(),
        })?;
        let mut journal = JsonlJournal::open(&config.state)?;
        journal.append(&event("evt-same"), signals::at(0))?;
        response_boundary(scenario, &mut journal)
    } else {
        Err(JournalError::Unavailable {
            detail: "unsupported crash-helper phase".to_owned(),
        })
    }
}

fn response_boundary(scenario: &Scenario, _journal: &mut JsonlJournal) -> Result<(), JournalError> {
    if scenario.id == "append-durable-before-response-write" {
        // The selected DurableAppendComplete callback blocks before this line.
        return Err(JournalError::OutcomeUnknown {
            detail: "durable response boundary unexpectedly released".to_owned(),
        });
    }
    let mut stderr = io::stderr().lock();
    stderr
        .write_all(ACK)
        .map_err(|error| JournalError::Unavailable {
            detail: format!("ack write failed: {error}"),
        })?;
    if scenario.id == "response-after-flush" || scenario.id == "response-normal-exit" {
        stderr.flush().map_err(|error| JournalError::Unavailable {
            detail: format!("ack flush failed: {error}"),
        })?;
    }
    if scenario.id == "response-normal-exit" {
        return Ok(());
    }
    let operation = if scenario.id == "response-after-write" {
        "response-write-complete"
    } else {
        "response-flush-complete"
    };
    write_ready(scenario, operation, "response", 1, None, None).map_err(|error| {
        JournalError::Unavailable {
            detail: format!("response ready failed: {error}"),
        }
    })?;
    wait_for_release().map_err(|error| JournalError::Unavailable {
        detail: format!("response release failed: {error}"),
    })
}

fn run_inspector(config: &HelperConfig) -> Result<(), JournalError> {
    let expected = result_expectation(config.scenario);
    validate_mutation_projection(config.scenario, expected)
        .map_err(|detail| JournalError::OutcomeUnknown { detail })?;
    let before = artifact_snapshot(&config.state).map_err(|error| JournalError::Unavailable {
        detail: error.to_string(),
    })?;
    let read = read_image(&config.state);
    assert_reader_projection(config.scenario, read)?;
    let after_read =
        artifact_snapshot(&config.state).map_err(|error| JournalError::Unavailable {
            detail: error.to_string(),
        })?;
    if before != after_read {
        return Err(JournalError::OutcomeUnknown {
            detail: "reader inspection mutated a state artifact".to_owned(),
        });
    }

    // Reconcile runs through the engine's read-only use case.  The store image
    // projection and the semantic result are checked independently: the
    // former belongs to store-v2 and the latter to the workflow classifier.
    let reconcile_before = after_read.clone();
    let reconcile_image = read_image(&config.state);
    assert_reconcile_projection(config.scenario, reconcile_image)?;
    let reconcile = reconcile_once(&config.state, "evt-same");
    assert_reconcile_outcome(config.scenario, reconcile)?;
    let reconcile_after =
        artifact_snapshot(&config.state).map_err(|error| JournalError::Unavailable {
            detail: error.to_string(),
        })?;
    if reconcile_before != reconcile_after {
        return Err(JournalError::OutcomeUnknown {
            detail: "reconcile inspection mutated a state artifact".to_owned(),
        });
    }

    // A failed or duplicate submit is required to be observational.
    // Successful submits are deliberately allowed to publish an ordinary
    // next event; this is the accepted operation projection for clean images.
    for (event_id, projection) in [
        ("evt-same", expected.same_submit),
        ("evt-next", expected.next_submit),
    ] {
        if projection == SubmitProjection::NotApplicable {
            continue;
        }
        let before =
            artifact_snapshot(&config.state).map_err(|error| JournalError::Unavailable {
                detail: error.to_string(),
            })?;
        let result = submit_once(&config.state, event_id);
        assert_submit_projection(config.scenario, projection, result)?;
        let after =
            artifact_snapshot(&config.state).map_err(|error| JournalError::Unavailable {
                detail: error.to_string(),
            })?;
        if expected.equality_required
            && matches!(
                projection,
                SubmitProjection::Error(_) | SubmitProjection::Duplicate
            )
            && before != after
        {
            return Err(JournalError::OutcomeUnknown {
                detail: "failed submit mutated a state artifact".to_owned(),
            });
        }
    }
    Ok(())
}

fn validate_mutation_projection(
    scenario: &Scenario,
    expected: &ResultExpectation,
) -> Result<(), String> {
    let valid = match expected.mutation {
        MutationProjection::FreshInitialization => scenario.result == "I0",
        MutationProjection::WitnessInitialization => scenario.result == "I2",
        MutationProjection::PreparedResume => scenario.result == "I4",
        MutationProjection::OrdinaryAppend => {
            matches!(
                scenario.result,
                "I5" | "A0" | "A3" | "C3" | "C4" | "C5" | "C7"
            )
        }
        MutationProjection::None => {
            matches!(
                scenario.result,
                "I1" | "I3" | "A1" | "A2" | "C1" | "C2" | "C6" | "C8"
            )
        }
    };
    if !valid {
        return Err(format!(
            "{} has a mutation projection inconsistent with result {} (authority: {})",
            scenario.id, scenario.result, expected.authority
        ));
    }
    Ok(())
}

fn read_image(state: &Path) -> Result<Vec<aizign_engine::JournalEntry>, JournalError> {
    JsonlJournalReader::open(state).and_then(|mut reader| reader.load_committed())
}

fn assert_reader_projection(
    scenario: &Scenario,
    result: Result<Vec<aizign_engine::JournalEntry>, JournalError>,
) -> Result<(), JournalError> {
    assert_image_projection(result_expectation(scenario).reader, result, "reader")
}

fn assert_reconcile_projection(
    scenario: &Scenario,
    result: Result<Vec<aizign_engine::JournalEntry>, JournalError>,
) -> Result<(), JournalError> {
    assert_image_projection(result_expectation(scenario).reconcile, result, "reconcile")
}

fn assert_image_projection(
    projection: ImageProjection,
    result: Result<Vec<aizign_engine::JournalEntry>, JournalError>,
    operation: &str,
) -> Result<(), JournalError> {
    match projection {
        ImageProjection::Error(expected) => match result {
            Err(error) if error.code() == expected => Ok(()),
            Err(error) => Err(JournalError::OutcomeUnknown {
                detail: format!(
                    "{operation} returned {} instead of {expected}",
                    error.code()
                ),
            }),
            Ok(_) => Err(JournalError::OutcomeUnknown {
                detail: format!("{operation} returned a known image instead of {expected}"),
            }),
        },
        ImageProjection::Known { entries: expected } => {
            let entries = result?;
            if entries.len() != expected {
                return Err(JournalError::OutcomeUnknown {
                    detail: format!(
                        "{operation} returned {} entries instead of {expected}",
                        entries.len()
                    ),
                });
            }
            Ok(())
        }
    }
}

fn reconcile_once(
    state: &Path,
    event_id: &'static str,
) -> Result<aizign_core::recovery::SignalReconciliation, &'static str> {
    let mut reader = JsonlJournalReader::open(state).map_err(|error| error.code())?;
    aizign_engine::reconcile_workflow_signal(&mut reader, &signals::implementation_ready(event_id))
        .map_err(|error| error.code())
}

fn assert_reconcile_outcome(
    scenario: &Scenario,
    result: Result<aizign_core::recovery::SignalReconciliation, &'static str>,
) -> Result<(), JournalError> {
    use aizign_core::recovery::SignalReconciliation;
    match result_expectation(scenario).reconcile {
        ImageProjection::Error(expected) => match result {
            Err(actual) if actual == expected => Ok(()),
            Err(actual) => Err(JournalError::OutcomeUnknown {
                detail: format!("reconcile returned {actual} instead of {expected}"),
            }),
            Ok(_) => Err(JournalError::OutcomeUnknown {
                detail: format!("reconcile succeeded instead of {expected}"),
            }),
        },
        ImageProjection::Known { .. } => {
            let expected =
                if result_expectation(scenario).same_submit == SubmitProjection::Duplicate {
                    SignalReconciliation::Accepted
                } else {
                    SignalReconciliation::Absent
                };
            match result {
                Ok(actual) if actual == expected => Ok(()),
                Ok(actual) => Err(JournalError::OutcomeUnknown {
                    detail: format!("reconcile returned {actual:?} instead of {expected:?}"),
                }),
                Err(actual) => Err(JournalError::OutcomeUnknown {
                    detail: format!("reconcile failed with {actual} on a known image"),
                }),
            }
        }
    }
}

fn submit_once(state: &Path, event_id: &'static str) -> Result<SignalOutcome, &'static str> {
    let mut journal = JsonlJournal::open(state).map_err(|error| error.code())?;
    aizign_engine::handle_workflow_signal(
        &mut journal,
        &FixedClock::default(),
        Command::SubmitSignal {
            signal: signals::implementation_ready(event_id),
            expected: signals::expected(),
        },
    )
    .map_err(|error| error.code())
}

fn assert_submit_projection(
    scenario: &Scenario,
    projection: SubmitProjection,
    result: Result<SignalOutcome, &'static str>,
) -> Result<(), JournalError> {
    match projection {
        SubmitProjection::NotApplicable => Ok(()),
        SubmitProjection::Accepted => match result {
            Ok(SignalOutcome::Accepted { .. }) => Ok(()),
            Ok(other) => Err(JournalError::OutcomeUnknown {
                detail: format!(
                    "scenario {} returned {other:?} instead of accepted",
                    scenario.id
                ),
            }),
            Err(actual) => Err(JournalError::OutcomeUnknown {
                detail: format!(
                    "scenario {} returned {actual} instead of accepted",
                    scenario.id
                ),
            }),
        },
        SubmitProjection::Duplicate => match result {
            Ok(SignalOutcome::Duplicate { .. }) => Ok(()),
            Ok(other) => Err(JournalError::OutcomeUnknown {
                detail: format!(
                    "scenario {} returned {other:?} instead of duplicate",
                    scenario.id
                ),
            }),
            Err(actual) => Err(JournalError::OutcomeUnknown {
                detail: format!(
                    "scenario {} returned {actual} instead of duplicate",
                    scenario.id
                ),
            }),
        },
        SubmitProjection::Error(expected) => match result {
            Err(actual) if actual == expected => Ok(()),
            Err(actual) => Err(JournalError::OutcomeUnknown {
                detail: format!(
                    "scenario {} returned {actual} instead of {expected}",
                    scenario.id
                ),
            }),
            Ok(other) => Err(JournalError::OutcomeUnknown {
                detail: format!(
                    "scenario {} returned {other:?} instead of {expected}",
                    scenario.id
                ),
            }),
        },
    }
}

struct LockedReader;

impl JournalReader for LockedReader {
    fn load_committed(&mut self) -> Result<Vec<aizign_engine::JournalEntry>, JournalError> {
        Err(JournalError::Locked)
    }
}

struct LockedJournal;

impl JournalReader for LockedJournal {
    fn load_committed(&mut self) -> Result<Vec<aizign_engine::JournalEntry>, JournalError> {
        Err(JournalError::Locked)
    }
}

impl Journal for LockedJournal {
    fn append(
        &mut self,
        _event: &WorkflowEvent,
        _at: aizign_core::BoundedTimestamp,
    ) -> Result<aizign_engine::JournalEntry, JournalError> {
        Err(JournalError::Locked)
    }
}

fn assert_engine_locked_submit() {
    let submit = aizign_engine::handle_workflow_signal(
        &mut LockedJournal,
        &FixedClock::default(),
        Command::SubmitSignal {
            signal: signals::implementation_ready("evt-same"),
            expected: signals::expected(),
        },
    )
    .expect_err("locked submit must fail");
    assert_eq!(submit.code(), "JOURNAL_LOCKED");
}

fn assert_engine_locked_reconcile() {
    let reconcile = aizign_engine::reconcile_workflow_signal(
        &mut LockedReader,
        &signals::implementation_ready("evt-same"),
    )
    .expect_err("locked reconcile must fail");
    assert_eq!(reconcile.code(), "JOURNAL_LOCKED");
}

fn run_contender(config: &HelperConfig) -> Result<(), JournalError> {
    let before = artifact_snapshot(&config.state).map_err(|error| JournalError::Unavailable {
        detail: error.to_string(),
    })?;
    if config.scenario.id == "concurrency-writer-after-partial-tail" {
        let result = JsonlJournal::open(&config.state);
        if !matches!(result, Err(JournalError::OutcomeUnknown { .. })) {
            return Err(JournalError::OutcomeUnknown {
                detail: "partial-tail contender did not return unknown".to_owned(),
            });
        }
    } else if matches!(
        config.scenario.id,
        "concurrency-same-event-submit"
            | "concurrency-different-event-submit"
            | "concurrency-submit-under-reader"
    ) {
        let result = JsonlJournal::open(&config.state);
        if !matches!(result, Err(JournalError::Locked)) {
            return Err(JournalError::Locked);
        }
        assert_engine_locked_submit();
    } else if config.scenario.id == "concurrency-reconcile-under-writer" {
        let result = JsonlJournalReader::open(&config.state);
        if !matches!(result, Err(JournalError::Locked)) {
            return Err(JournalError::Locked);
        }
        assert_engine_locked_reconcile();
    } else {
        let result = JsonlJournalReader::open(&config.state);
        if !matches!(result, Err(JournalError::Locked)) {
            return Err(JournalError::Locked);
        }
    }
    let after = artifact_snapshot(&config.state).map_err(|error| JournalError::Unavailable {
        detail: error.to_string(),
    })?;
    if before != after {
        return Err(JournalError::OutcomeUnknown {
            detail: "contender mutated a state artifact".to_owned(),
        });
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ArtifactState {
    file_type: u8,
    mode: u32,
    device: u64,
    inode: u64,
    links: u64,
    bytes: Vec<u8>,
    digest: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ArtifactSnapshot {
    directory: ArtifactState,
    files: BTreeMap<String, Option<ArtifactState>>,
}

#[allow(clippy::too_many_lines)]
fn artifact_snapshot(state: &Path) -> io::Result<ArtifactSnapshot> {
    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    const RESERVED: &[&str] = &[
        LOCK_FILE_NAME,
        JOURNAL_FILE_NAME,
        COMMIT_FILE_NAME,
        PUBLISH_FILE_NAME,
        "workflow.commit.tmp",
    ];

    let directory_metadata = fs::symlink_metadata(state)?;
    if !directory_metadata.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "state path is not a directory",
        ));
    }
    #[cfg(unix)]
    let directory_mode = directory_metadata.permissions().mode();
    #[cfg(not(unix))]
    let directory_mode = 0;
    #[cfg(unix)]
    let (directory_device, directory_inode, directory_links) = (
        directory_metadata.dev(),
        directory_metadata.ino(),
        directory_metadata.nlink(),
    );
    #[cfg(not(unix))]
    let (directory_device, directory_inode, directory_links) = (0, 0, 0);
    let directory = ArtifactState {
        file_type: 2,
        mode: directory_mode,
        device: directory_device,
        inode: directory_inode,
        links: directory_links,
        bytes: Vec::new(),
        digest: hash_bytes(&[]),
    };

    let mut files = RESERVED
        .iter()
        .map(|name| ((*name).to_owned(), None))
        .collect::<BTreeMap<_, _>>();
    for entry in fs::read_dir(state)? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "state entry name is not UTF-8")
        })?;
        if !RESERVED.iter().any(|reserved| *reserved == name) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected state artifact: {name}"),
            ));
        }
        let path = state.join(&name);
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.len() >= MAX_ARTIFACT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "artifact is not strictly below the bounded evidence size",
            ));
        }
        if !metadata.file_type().is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("reserved artifact is not a regular file: {name}"),
            ));
        }
        let bytes = if metadata.file_type().is_file() {
            fs::read(&path)?
        } else {
            Vec::new()
        };
        if name == JOURNAL_FILE_NAME {
            let records = bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .count();
            if records > 2 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "journal exceeds the two-record crash evidence bound",
                ));
            }
        }
        #[cfg(unix)]
        let mode = metadata.permissions().mode();
        #[cfg(not(unix))]
        let mode = 0;
        #[cfg(unix)]
        let (device, inode, links) = (metadata.dev(), metadata.ino(), metadata.nlink());
        #[cfg(not(unix))]
        let (device, inode, links) = (0, 0, 0);
        let file_type = if metadata.file_type().is_file() {
            1
        } else if metadata.file_type().is_dir() {
            2
        } else if metadata.file_type().is_symlink() {
            3
        } else {
            4
        };
        files.insert(
            name,
            Some(ArtifactState {
                file_type,
                mode,
                device,
                inode,
                links,
                digest: hash_bytes(&bytes),
                bytes,
            }),
        );
    }
    Ok(ArtifactSnapshot { directory, files })
}

fn wait_child(child: &mut Child, timeout: Duration) -> io::Result<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "crash helper timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn child_command(config: &HelperConfig) -> io::Result<ProcessCommand> {
    let executable = std::env::current_exe()?;
    let mut command = ProcessCommand::new(executable);
    command
        .arg("crash_harness::tests::child_process_entry")
        .arg("--exact")
        .arg("--ignored")
        .arg("--nocapture")
        .env(MODE_ENV, MODE)
        .env(CASE_ENV, config.scenario.id)
        .env(STATE_ENV, &config.state)
        .env(ROLE_ENV, config.role.name())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command)
}

fn parse_ready(line: &str, scenario: &Scenario) -> io::Result<ParsedReadyRecord> {
    let payload = line.trim_end_matches(['\r', '\n']);
    let value: serde_json::Value = serde_json::from_str(payload).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("malformed ready record: {error}"),
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "ready record is not an object")
    })?;
    if object.len() != READY_RECORD_KEYS.len()
        || READY_RECORD_KEYS
            .iter()
            .any(|key| !object.contains_key(*key))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ready record has an unexpected field set",
        ));
    }
    let record: ParsedReadyRecord = serde_json::from_value(value).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("malformed ready record: {error}"),
        )
    })?;
    if record.record_type != "ready"
        || record.harness_version != 1
        || record.case_id != scenario.id
        || record.phase != scenario.phase
        || record.operation != scenario.operation
        || record.artifact != scenario.artifact
        || record.occurrence != scenario.occurrence
        || record.durability_point.as_deref() != durability_point_name(scenario.durability_point)
        || (scenario.partial_kind.is_some()) != record.byte_count.is_some()
        || (scenario.partial_kind.is_none() && record.byte_count.is_some())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ready record does not match scenario",
        ));
    }
    Ok(record)
}

fn validate_ready_measurement(
    record: &ParsedReadyRecord,
    scenario: &Scenario,
    state: &Path,
) -> io::Result<()> {
    let Some(kind) = scenario.partial_kind else {
        if record.byte_count.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "non-partial ready record contains byteCount",
            ));
        }
        return Ok(());
    };
    let journal = fs::read(state.join(JOURNAL_FILE_NAME))?;
    // The partial-write scenarios append the first record to a clean empty
    // journal, so there may be no committed newline before the selected
    // prefix.  If a future fixture has a committed prefix, the last newline
    // still identifies the selected record just as precisely.
    let base = journal
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let entry = aizign_engine::JournalEntry {
        seq: 1,
        at: signals::at(0),
        event: event("evt-same"),
    };
    let mut encoded = crate::record::encode_entry(&entry)
        .map_err(|error| io::Error::other(format!("partial fixture encoding failed: {error}")))?
        .into_bytes();
    encoded.push(b'\n');
    if encoded.len() <= 2 || journal.len() < base || journal.len() - base > encoded.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "partial fixture record length is outside its closed bound",
        ));
    }
    let actual_prefix = journal.len() - base;
    if journal[base..] != encoded[..actual_prefix] {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "partial fixture bytes differ from the production encoded record",
        ));
    }
    let expected = match kind {
        1 => 1,
        2 => encoded.len() / 2,
        3 => encoded.len() - 1,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unknown partial kind",
            ));
        }
    };
    if record.byte_count != Some(expected) || actual_prefix != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "partial byteCount mismatch: expected {expected}, ready {:?}, image {actual_prefix}",
                record.byte_count
            ),
        ));
    }
    Ok(())
}

fn start_helper(config: &HelperConfig) -> io::Result<Child> {
    child_command(config)?.spawn()
}

/// A line-oriented stdout collector.  `ChildStdout::read_line` is intentionally
/// performed on a separate thread: a helper which never emits its rendezvous
/// line must still be subject to the ten-second parent deadline.
struct ChildOutput {
    lines: Receiver<io::Result<Option<String>>>,
    stderr: Receiver<io::Result<Option<Vec<u8>>>>,
}

fn start_output_reader(child: &mut Child) -> io::Result<ChildOutput> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("helper stdout was not piped"))?;
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("aizign-store-crash-stdout".to_owned())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ = sender.send(Ok(None));
                        break;
                    }
                    Ok(_) => {
                        if sender.send(Ok(Some(line))).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        })
        .map_err(|error| io::Error::other(format!("cannot start stdout reader: {error}")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("helper stderr was not piped"))?;
    let (stderr_sender, stderr_receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("aizign-store-crash-stderr".to_owned())
        .spawn(move || {
            let mut reader = stderr;
            let mut bytes = [0_u8; 4096];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => {
                        let _ = stderr_sender.send(Ok(None));
                        break;
                    }
                    Ok(length) => {
                        if stderr_sender
                            .send(Ok(Some(bytes[..length].to_vec())))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = stderr_sender.send(Err(error));
                        break;
                    }
                }
            }
        })
        .map_err(|error| io::Error::other(format!("cannot start stderr reader: {error}")))?;
    Ok(ChildOutput {
        lines: receiver,
        stderr: stderr_receiver,
    })
}

fn read_until_ready(
    child: &mut Child,
    output: &ChildOutput,
    scenario: &Scenario,
) -> io::Result<ParsedReadyRecord> {
    let deadline = Instant::now() + CHILD_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "waiting for helper ready record",
            ));
        }
        match output.lines.recv_timeout(remaining) {
            Ok(Ok(Some(line))) => {
                let trimmed = line.trim_end_matches(['\r', '\n']).trim();
                // libtest's status chatter is not a control record.  Any
                // JSON-looking line, however, is owned by this protocol and
                // must be a valid ready record.
                if trimmed.starts_with('{') {
                    return parse_ready(&line, scenario);
                }
                if trimmed.starts_with('[') {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "unexpected JSON control record before ready",
                    ));
                }
            }
            Ok(Ok(None)) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "helper exited before ready",
                ));
            }
            Ok(Err(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "waiting for helper ready record",
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stdout reader disconnected before ready",
                ));
            }
        }
    }
}

fn assert_output_closed(output: &ChildOutput, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "helper stdout did not reach EOF",
            ));
        }
        match output.lines.recv_timeout(remaining) {
            Ok(Ok(Some(line))) => {
                let trimmed = line.trim_end_matches(['\r', '\n']).trim();
                if trimmed.starts_with('{') || trimmed.starts_with('[') {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "unexpected extra JSON control record",
                    ));
                }
            }
            Ok(Ok(None)) | Err(RecvTimeoutError::Disconnected) => return Ok(()),
            Ok(Err(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "helper stdout did not reach EOF",
                ));
            }
        }
    }
}

fn collect_stderr(output: &ChildOutput, timeout: Duration) -> io::Result<Vec<u8>> {
    let deadline = Instant::now() + timeout;
    let mut bytes = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "helper stderr did not reach EOF",
            ));
        }
        match output.stderr.recv_timeout(remaining) {
            Ok(Ok(Some(chunk))) => {
                bytes.extend_from_slice(&chunk);
                if bytes.len() as u64 >= MAX_ARTIFACT_BYTES {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "helper stderr exceeded bounded evidence size",
                    ));
                }
            }
            Ok(Ok(None)) | Err(RecvTimeoutError::Disconnected) => return Ok(bytes),
            Ok(Err(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "helper stderr did not reach EOF",
                ));
            }
        }
    }
}

fn expected_stderr(scenario: &Scenario) -> Option<&'static [u8]> {
    if scenario.id == "append-durable-before-response-write" {
        Some(&[])
    } else if scenario.phase == "response" {
        Some(ACK)
    } else {
        None
    }
}

fn assert_stderr(output: &ChildOutput, scenario: &Scenario, timeout: Duration) -> io::Result<()> {
    let bytes = collect_stderr(output, timeout)?;
    if let Some(expected) = expected_stderr(scenario)
        && bytes.as_slice() != expected
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "stderr acknowledgement mismatch for {}: got {} bytes, expected {}",
                scenario.id,
                bytes.len(),
                expected.len()
            ),
        ));
    }
    Ok(())
}

fn bounded_stderr(bytes: &[u8]) -> String {
    const MAX_CHARS: usize = 4_096;
    let rendered = String::from_utf8_lossy(bytes);
    if rendered.chars().count() <= MAX_CHARS {
        rendered.into_owned()
    } else {
        format!(
            "{}...[truncated]",
            rendered.chars().take(MAX_CHARS).collect::<String>()
        )
    }
}

fn release_child(child: &mut Child) -> io::Result<()> {
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| io::Error::other("helper stdin was not piped"))?;
    stdin.write_all(&[1])?;
    stdin.flush()
}

fn kill_and_reap(child: &mut Child) -> io::Result<std::process::ExitStatus> {
    child.kill()?;
    child.wait()
}

fn assert_sigkill(status: std::process::ExitStatus, context: &str) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        if status.signal() != Some(9) {
            return Err(io::Error::other(format!(
                "{context} exited with {:?}, expected SIGKILL",
                status.signal()
            )));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        let _ = context;
        Err(io::Error::other(
            "SIGKILL evidence is unavailable on non-Unix",
        ))
    }
}

fn assert_normal_exit(status: std::process::ExitStatus, context: &str) -> io::Result<()> {
    if !status.success() {
        return Err(io::Error::other(format!(
            "{context} exited unsuccessfully: {status}"
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        if status.signal().is_some() {
            return Err(io::Error::other(format!(
                "{context} was terminated by signal {:?}",
                status.signal()
            )));
        }
    }
    Ok(())
}

fn execute_scenario(scenario: &'static Scenario) -> io::Result<()> {
    let temporary = TempDir::new();
    let state = temporary.state();
    let config = HelperConfig {
        scenario,
        role: if scenario.is_response() {
            Role::ResponseChild
        } else {
            Role::Holder
        },
        state,
    };
    if scenario.normal_exit {
        let mut child = start_helper(&config)?;
        let output = start_output_reader(&mut child)?;
        let status = wait_child(&mut child, CHILD_TIMEOUT)?;
        assert_output_closed(&output, CHILD_TIMEOUT)?;
        assert_stderr(&output, scenario, CHILD_TIMEOUT)?;
        assert_normal_exit(status, "normal-exit helper")?;
        return run_inspection_after_exit(scenario, &config.state);
    }

    let mut holder = start_helper(&config)?;
    let holder_output = start_output_reader(&mut holder)?;
    let ready = match read_until_ready(&mut holder, &holder_output, scenario) {
        Ok(record) => record,
        Err(error) => {
            let _ = kill_and_reap(&mut holder);
            let _ = assert_output_closed(&holder_output, CHILD_TIMEOUT);
            let stderr = collect_stderr(&holder_output, CHILD_TIMEOUT).unwrap_or_default();
            return Err(io::Error::new(
                error.kind(),
                format!(
                    "{} failed before ready: {error}; stderr: {}",
                    scenario.id,
                    bounded_stderr(&stderr)
                ),
            ));
        }
    };
    validate_ready_measurement(&ready, scenario, &config.state)?;
    if scenario.partial_kind.is_some() && ready.byte_count.unwrap_or(0) == 0 {
        return Err(io::Error::other("partial case omitted bounded byte count"));
    }
    if scenario.is_concurrency() && scenario.id != "concurrency-writer-after-partial-tail" {
        let contender_config = HelperConfig {
            scenario,
            role: Role::Contender,
            state: config.state.clone(),
        };
        let mut contender = start_helper(&contender_config)?;
        let contender_output = start_output_reader(&mut contender)?;
        let status = wait_child(&mut contender, CHILD_TIMEOUT)?;
        assert_output_closed(&contender_output, CHILD_TIMEOUT)?;
        assert_stderr(&contender_output, scenario, CHILD_TIMEOUT)?;
        if let Err(error) = assert_normal_exit(status, "contender while holder was blocked") {
            let _ = kill_and_reap(&mut holder);
            return Err(error);
        }
        if scenario.id == "concurrency-reader-at-clean"
            || scenario.id == "concurrency-same-event-submit"
            || scenario.id == "concurrency-different-event-submit"
            || scenario.id == "concurrency-reconcile-under-writer"
            || scenario.id == "concurrency-submit-under-reader"
        {
            release_child(&mut holder)?;
            let status = wait_child(&mut holder, CHILD_TIMEOUT)?;
            assert_normal_exit(status, "released concurrency holder")?;
        } else {
            let status = kill_and_reap(&mut holder)?;
            assert_sigkill(status, "crash-matrix holder")?;
        }
        assert_output_closed(&holder_output, CHILD_TIMEOUT)?;
        assert_stderr(&holder_output, scenario, CHILD_TIMEOUT)?;
        return run_inspection_after_exit(scenario, &config.state);
    }
    if scenario.id == "concurrency-writer-after-partial-tail" {
        let status = kill_and_reap(&mut holder)?;
        assert_sigkill(status, "partial-tail holder")?;
        let contender_config = HelperConfig {
            scenario,
            role: Role::Contender,
            state: config.state.clone(),
        };
        let mut contender = start_helper(&contender_config)?;
        let contender_output = start_output_reader(&mut contender)?;
        let status = wait_child(&mut contender, CHILD_TIMEOUT)?;
        assert_output_closed(&contender_output, CHILD_TIMEOUT)?;
        assert_stderr(&contender_output, scenario, CHILD_TIMEOUT)?;
        assert_normal_exit(status, "post-kill partial-tail writer")?;
        assert_output_closed(&holder_output, CHILD_TIMEOUT)?;
        assert_stderr(&holder_output, scenario, CHILD_TIMEOUT)?;
        return run_inspection_after_exit(scenario, &config.state);
    }
    let status = kill_and_reap(&mut holder)?;
    assert_sigkill(status, "crash-matrix holder")?;
    assert_output_closed(&holder_output, CHILD_TIMEOUT)?;
    assert_stderr(&holder_output, scenario, CHILD_TIMEOUT)?;
    run_inspection_after_exit(scenario, &config.state)
}

fn run_inspection_after_exit(scenario: &'static Scenario, state: &Path) -> io::Result<()> {
    let inspector_config = HelperConfig {
        scenario,
        role: Role::Inspector,
        state: state.to_path_buf(),
    };
    let mut inspector = start_helper(&inspector_config)?;
    let output = start_output_reader(&mut inspector)?;
    let status = wait_child(&mut inspector, CHILD_TIMEOUT)?;
    assert_output_closed(&output, CHILD_TIMEOUT)?;
    let stderr = collect_stderr(&output, CHILD_TIMEOUT)?;
    if let Err(error) = assert_normal_exit(status, "fresh inspector") {
        return Err(io::Error::other(format!(
            "{error}; stderr: {}",
            bounded_stderr(&stderr)
        )));
    }
    if !stderr.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "fresh inspector emitted unexpected stderr: {}",
                bounded_stderr(&stderr)
            ),
        ));
    }
    Ok(())
}

/// Verify the small set of external authorities that the process matrix
/// names directly.  In particular, lock contention is classified by looking
/// up the operation-qualified row in the repository corpus, rather than by
/// copying that row into this test-only module.
#[allow(clippy::too_many_lines)]
fn validate_authorities() -> io::Result<()> {
    const REQUIRED_HEADINGS: &[&str] = &[
        "# JSONL store metadata v2",
        "## Artifact set and physical rules",
        "## Zero-entry initialization",
        "## Existing-image matrix",
        "## Clean authority",
        "## Append publication order",
        "### Bounded visible-CLEAN exception",
        "## Production crash-stage evidence",
        "## Supported storage profile",
    ];
    for heading in REQUIRED_HEADINGS {
        if !STORE_AUTHORITY.lines().any(|line| line.trim() == *heading) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("store authority heading is missing: {heading}"),
            ));
        }
    }
    for required in [
        "# ADR-0013: Add bounded read-only workflow signal reconciliation",
        "acquire the shared advisory lock without waiting",
        "An active writer makes a non-blocking reconciliation attempt",
        "A non-blocking lock failure remains `unknown`",
    ] {
        if !RECONCILIATION_AUTHORITY.contains(required) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("ADR-0013 authority text is missing: {required}"),
            ));
        }
    }

    let document: serde_json::Value =
        serde_json::from_str(CLASSIFICATION_AUTHORITY).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("classification corpus: {error}"),
            )
        })?;
    let rows = document
        .get("rows")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "classification corpus has no rows",
            )
        })?;
    let mut submit = 0_u8;
    let mut reconcile = 0_u8;
    for row in rows {
        let operation = row.get("operation").and_then(serde_json::Value::as_str);
        let code = row
            .get("reportedCode")
            .and_then(serde_json::Value::as_object)
            .and_then(|code| {
                (code.get("kind").and_then(serde_json::Value::as_str) == Some("fixed"))
                    .then(|| code.get("value").and_then(serde_json::Value::as_str))
            })
            .flatten();
        if code != Some("JOURNAL_LOCKED") {
            continue;
        }
        let response_kind = row
            .get("responseCase")
            .and_then(serde_json::Value::as_object)
            .and_then(|case| case.get("kind"))
            .and_then(serde_json::Value::as_str);
        if response_kind != Some("error") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "JOURNAL_LOCKED classification row is not an error row",
            ));
        }
        let expected = match operation {
            Some("workflow.signal.submit") => {
                submit = submit.saturating_add(1);
                "rejected"
            }
            Some("workflow.signal.reconcile") => {
                reconcile = reconcile.saturating_add(1);
                "unknown"
            }
            _ => continue,
        };
        let value = |field: &str| row.get(field).and_then(serde_json::Value::as_str);
        let observation = |field: &str| {
            row.get(field)
                .and_then(serde_json::Value::as_object)
                .and_then(|value| value.get("value"))
                .and_then(serde_json::Value::as_str)
        };
        if value("clientOutcome") != Some(expected)
            || observation("childObservation") != Some(expected)
            || observation("parentObservation") != Some(expected)
            || row.get("automaticRetryAuthorized") != Some(&serde_json::Value::Bool(false))
            || row.get("serverDisposition") != Some(&serde_json::Value::Null)
            || row.get("reconciliationDisposition") != Some(&serde_json::Value::Null)
            || row.get("timingCodeDisclosure") != Some(&serde_json::Value::Bool(true))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("JOURNAL_LOCKED {operation:?} row has unexpected projections"),
            ));
        }
    }
    if submit != 1 || reconcile != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "expected one submit and one reconcile JOURNAL_LOCKED row, got {submit}/{reconcile}"
            ),
        ));
    }
    Ok(())
}

fn assert_manifest() {
    assert_eq!(SCENARIOS.len(), 61, "closed store-crash scenario manifest");
    let ids = SCENARIOS
        .iter()
        .map(|scenario| scenario.id)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        ids.len(),
        SCENARIOS.len(),
        "duplicate store-crash scenario ID"
    );
    assert_eq!(
        MUTATION_SENTINELS.len(),
        9,
        "mutation sentinel manifest must stay closed"
    );
    let sentinel_ids = MUTATION_SENTINELS.iter().copied().collect::<BTreeSet<_>>();
    assert_eq!(
        sentinel_ids.len(),
        MUTATION_SENTINELS.len(),
        "duplicate mutation sentinel ID"
    );
    assert_eq!(
        RESULT_EXPECTATIONS.len(),
        18,
        "store-crash result manifest must stay closed",
    );
    let expected_result_ids = [
        "I0", "I1", "I2", "I3", "I4", "I5", "A0", "A1", "A2", "A3", "C1", "C2", "C3", "C4", "C5",
        "C6", "C7", "C8",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let result_ids = RESULT_EXPECTATIONS
        .iter()
        .map(|expectation| expectation.code)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        result_ids, expected_result_ids,
        "result manifest must contain exactly I0..I5, A0..A3, and C1..C8",
    );
    for expectation in RESULT_EXPECTATIONS {
        assert!(!expectation.authority.is_empty());
        assert!(expectation.equality_required);
    }
    for scenario in SCENARIOS {
        assert!(!scenario.id.is_empty());
        assert!(matches!(
            scenario.actor,
            "holder" | "response-child" | "parent-observed-exit"
        ));
        assert!(matches!(
            scenario.result,
            "I0" | "I1"
                | "I2"
                | "I3"
                | "I4"
                | "I5"
                | "A0"
                | "A1"
                | "A2"
                | "A3"
                | "C1"
                | "C2"
                | "C3"
                | "C4"
                | "C5"
                | "C6"
                | "C7"
                | "C8"
        ));
        if scenario.normal_exit {
            assert_eq!(scenario.actor, "parent-observed-exit");
        }
        assert!(
            RESULT_EXPECTATIONS
                .iter()
                .filter(|expectation| expectation.code == scenario.result)
                .count()
                == 1,
            "scenario {} must resolve to exactly one result record",
            scenario.id
        );
    }
}

fn run_required_matrix() -> io::Result<()> {
    assert_manifest();
    validate_authorities()?;
    if !crate::journal::STORE_PLATFORM_SUPPORTED {
        return Ok(());
    }
    let started = Instant::now();
    let mut executed = BTreeSet::new();
    for scenario in SCENARIOS {
        if started.elapsed() > MATRIX_TIMEOUT {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "crash matrix exceeded four-minute bound",
            ));
        }
        execute_scenario(scenario)?;
        if !executed.insert(scenario.id) {
            return Err(io::Error::other("scenario executed more than once"));
        }
    }
    if executed.len() != SCENARIOS.len() {
        return Err(io::Error::other("scenario execution set is incomplete"));
    }

    let mut sentinels = BTreeSet::new();
    for sentinel in MUTATION_SENTINELS {
        run_sentinel(sentinel);
        if !sentinels.insert(*sentinel) {
            return Err(io::Error::other(
                "mutation sentinel executed more than once",
            ));
        }
    }
    if sentinels.len() != MUTATION_SENTINELS.len() {
        return Err(io::Error::other(
            "mutation sentinel execution set is incomplete",
        ));
    }

    // Build profile evidence from a directory actually accepted by the
    // production qualifier.  The profile module owns filesystem type/magic,
    // mount, and device observations; this harness adds only the closed
    // campaign/toolchain fields.
    let evidence_dir = TempDir::new();
    let opened =
        with_controller_disabled(|| JsonlJournal::open(&evidence_dir.state()).map(drop))
            .map_err(|error| io::Error::other(format!("profile evidence setup failed: {error}")))?;
    opened.map_err(|error| io::Error::other(format!("profile evidence setup failed: {error}")))?;
    let evidence = supported_profile_metadata(&evidence_dir.state())?;
    println!(
        "AIZIGN_STORE_CRASH_EVIDENCE={}",
        serde_json::to_string(&evidence)
            .map_err(|error| io::Error::other(format!("evidence serialization failed: {error}")))?
    );
    Ok(())
}

fn supported_profile_metadata(state: &Path) -> io::Result<serde_json::Value> {
    let opened = File::open(state)?;
    let qualified =
        crate::profile::qualify_directory(&opened, &mut crate::profile::ProductionProfile)
            .map_err(|error| io::Error::other(format!("profile qualification failed: {error}")))?;
    let mut evidence =
        serde_json::to_value(crate::profile::profile_evidence(&qualified)).map_err(|error| {
            io::Error::other(format!("profile evidence serialization failed: {error}"))
        })?;
    let object = evidence.as_object_mut().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "profile evidence is not an object",
        )
    })?;
    object.insert(
        "rustToolchain".to_owned(),
        serde_json::Value::String("1.97.1".to_owned()),
    );
    object.insert(
        "rustcVersion".to_owned(),
        serde_json::Value::String(rustc_version_line()),
    );
    object.insert(
        "scenarioCount".to_owned(),
        serde_json::Value::from(SCENARIOS.len() as u64),
    );
    object.insert(
        "mutationSentinelCount".to_owned(),
        serde_json::Value::from(MUTATION_SENTINELS.len() as u64),
    );
    Ok(evidence)
}

fn rustc_version_line() -> String {
    let output = ProcessCommand::new("rustc").arg("--version").output();
    let Ok(output) = output else {
        return "unavailable".to_owned();
    };
    if !output.status.success() {
        return "unavailable".to_owned();
    }
    let Ok(mut line) = String::from_utf8(output.stdout) else {
        return "unavailable".to_owned();
    };
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    if line.is_empty() || line.len() > 256 || line.contains(['\r', '\n']) {
        "unavailable".to_owned()
    } else {
        line
    }
}

/// Return one production item, rather than scanning to the end of the file.
///
/// The mutation campaign edits function bodies in throwaway candidates.  A
/// source assertion which searches to EOF can accidentally find a later test
/// fixture's spelling of the same durability point and therefore accept a
/// mutant.  Keep the sentinel proof scoped to the actual production function
/// or impl body.  This small lexer deliberately understands comments, quoted
/// strings, character literals, and raw strings because production error
/// messages contain braces of their own.
fn production_function<'a>(source: &'a str, name: &str) -> &'a str {
    let marker = format!("fn {name}(");
    let start = source
        .find(&marker)
        .unwrap_or_else(|| panic!("production source marker is missing: {marker}"));
    let open = source[start..].find('{').map_or_else(
        || panic!("production function body is missing: {name}"),
        |offset| start + offset,
    );
    let close = matching_brace(source, open)
        .unwrap_or_else(|| panic!("production function body is unbalanced: {name}"));
    &source[start..=close]
}

fn source_between<'a>(source: &'a str, start_marker: &str, end_marker: &str) -> &'a str {
    let start = source
        .find(start_marker)
        .unwrap_or_else(|| panic!("production source marker is missing: {start_marker}"));
    let relative_end = source[start..]
        .find(end_marker)
        .unwrap_or_else(|| panic!("production source marker is missing: {end_marker}"));
    &source[start..start + relative_end]
}

#[allow(clippy::too_many_lines)]
fn matching_brace(source: &str, open: usize) -> Option<usize> {
    #[derive(Clone, Copy)]
    enum State {
        Code,
        LineComment,
        BlockComment(u32),
        String,
        Character,
        RawString(usize),
    }

    let bytes = source.as_bytes();
    if bytes.get(open) != Some(&b'{') {
        return None;
    }
    let mut depth = 0_u32;
    let mut state = State::Code;
    let mut index = open;
    while index < bytes.len() {
        match state {
            State::Code => match bytes[index] {
                b'/' if bytes.get(index + 1) == Some(&b'/') => {
                    state = State::LineComment;
                    index += 2;
                }
                b'/' if bytes.get(index + 1) == Some(&b'*') => {
                    state = State::BlockComment(1);
                    index += 2;
                }
                b'"' => {
                    state = State::String;
                    index += 1;
                }
                b'\'' => {
                    state = State::Character;
                    index += 1;
                }
                b'r' => {
                    let mut cursor = index + 1;
                    while bytes.get(cursor) == Some(&b'#') {
                        cursor += 1;
                    }
                    if bytes.get(cursor) == Some(&b'"') {
                        state = State::RawString(cursor - index - 1);
                        index = cursor + 1;
                    } else {
                        index += 1;
                    }
                }
                b'{' => {
                    depth = depth.checked_add(1)?;
                    index += 1;
                }
                b'}' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        return Some(index);
                    }
                    index += 1;
                }
                _ => index += 1,
            },
            State::LineComment => {
                if bytes[index] == b'\n' {
                    state = State::Code;
                }
                index += 1;
            }
            State::BlockComment(mut level) => {
                if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
                    level = level.checked_add(1)?;
                    state = State::BlockComment(level);
                    index += 2;
                } else if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                    level = level.checked_sub(1)?;
                    state = if level == 0 {
                        State::Code
                    } else {
                        State::BlockComment(level)
                    };
                    index += 2;
                } else {
                    index += 1;
                }
            }
            State::String => {
                if bytes[index] == b'\\' {
                    index = index.saturating_add(2);
                } else {
                    if bytes[index] == b'"' {
                        state = State::Code;
                    }
                    index += 1;
                }
            }
            State::Character => {
                if bytes[index] == b'\\' {
                    index = index.saturating_add(2);
                } else {
                    if bytes[index] == b'\'' {
                        state = State::Code;
                    }
                    index += 1;
                }
            }
            State::RawString(hashes) => {
                if bytes[index] == b'"'
                    && bytes
                        .get(index + 1..index + 1 + hashes)
                        .is_some_and(|suffix| suffix.iter().all(|byte| *byte == b'#'))
                {
                    index += hashes + 1;
                    state = State::Code;
                } else {
                    index += 1;
                }
            }
        }
    }
    None
}

fn assert_source_order(source: &str, markers: &[&str], context: &str) {
    let mut offset = 0;
    for marker in markers {
        let relative = source[offset..]
            .find(marker)
            .unwrap_or_else(|| panic!("{context}: production source marker is missing: {marker}"));
        offset += relative + marker.len();
    }
}

#[allow(clippy::too_many_lines)]
fn assert_sentinel_source(name: &str) {
    match name {
        "mutation-prepared-barrier-noop"
        | "mutation-journal-barrier-noop"
        | "mutation-commit-temporary-barrier-noop"
        | "mutation-commit-directory-barrier-noop"
        | "mutation-clean-barrier-noop" => {
            let barrier_name = if name == "mutation-commit-directory-barrier-noop" {
                "barrier_directory"
            } else {
                "barrier_file"
            };
            let barrier = production_function(DURABILITY_SOURCE, barrier_name);
            let sync_call = if name == "mutation-commit-directory-barrier-noop" {
                "directory.sync_all()?;"
            } else {
                "file.sync_all()?;"
            };
            assert_source_order(
                barrier,
                &[
                    "self.before(point)?",
                    sync_call,
                    "self.after(point)?",
                    "primitive_complete",
                ],
                name,
            );
            let point = match name {
                "mutation-prepared-barrier-noop" => "DurabilityPoint::PreparedBarrierComplete",
                "mutation-journal-barrier-noop" => "DurabilityPoint::JournalBarrierComplete",
                "mutation-commit-temporary-barrier-noop" => {
                    "DurabilityPoint::CommitTemporaryBarrierComplete"
                }
                "mutation-commit-directory-barrier-noop" => {
                    "DurabilityPoint::CommitDirectoryBarrierComplete"
                }
                "mutation-clean-barrier-noop" => "DurabilityPoint::CleanBarrierComplete",
                _ => unreachable!(),
            };
            let callsite = match name {
                "mutation-prepared-barrier-noop" => {
                    production_function(JOURNAL_SOURCE, "initialize_witness")
                }
                "mutation-journal-barrier-noop" | "mutation-clean-barrier-noop" => {
                    production_function(JOURNAL_SOURCE, "append_with_ops")
                }
                "mutation-commit-temporary-barrier-noop"
                | "mutation-commit-directory-barrier-noop" => {
                    production_function(JOURNAL_SOURCE, "publish_commit")
                }
                _ => unreachable!(),
            };
            assert!(
                callsite.contains(point),
                "{name}: selected durability point disappeared from its production callsite"
            );
            assert!(
                !barrier.contains(&format!("if point != {point}")),
                "{name}: selected barrier must not conditionally skip its sync"
            );
        }
        "mutation-commit-before-journal-barrier" => {
            let append = production_function(JOURNAL_SOURCE, "append_with_ops");
            assert_source_order(
                append,
                &[
                    "DurabilityPoint::JournalRecordWriteComplete",
                    "DurabilityPoint::JournalBarrierComplete",
                    "publish_commit(",
                ],
                name,
            );
        }
        "mutation-reader-accepts-incomplete-generation" => {
            let reader = source_between(
                JOURNAL_SOURCE,
                "impl JsonlJournalReader {",
                "impl JournalReader for JsonlJournalReader",
            );
            assert_source_order(
                reader,
                &[
                    "require_existing_path(&publish_path, \"publication witness\")?",
                    "JournalLock::acquire_shared",
                ],
                name,
            );
            let snapshot = production_function(JOURNAL_SOURCE, "read_snapshot_observed");
            assert!(
                snapshot.contains("validate_prepared_commit_prefix"),
                "{name}: reader lost PREPARED validation"
            );
        }
        "mutation-tail-repair-or-promotion" => {
            let snapshot = production_function(JOURNAL_SOURCE, "read_snapshot_observed");
            assert!(
                snapshot.contains("validate_prepared_commit_prefix")
                    && snapshot.contains("journal contains bytes beyond the clean commit point"),
                "{name}: tail must be rejected by production validation"
            );
            let reader = source_between(
                JOURNAL_SOURCE,
                "impl JsonlJournalReader {",
                "impl JournalReader for JsonlJournalReader",
            );
            assert!(
                !reader.contains("set_len(0)") && !reader.contains("truncate"),
                "{name}: reader must not repair or promote a tail"
            );
        }
        "mutation-append-revalidation-bypass" => {
            let append = production_function(JOURNAL_SOURCE, "append_with_ops");
            assert_source_order(
                append,
                &[
                    "revalidate_lock(",
                    "read_snapshot_observed(",
                    "read_publish_witness(",
                    "publication witness changed after append revalidation",
                ],
                name,
            );
        }
        _ => panic!("sentinel is not in the closed manifest: {name}"),
    }
}

fn run_append_revalidation_fixture() {
    let temporary = TempDir::new();
    let state = temporary.state();
    prepare_clean_state(&state).expect("revalidation fixture setup");
    let mut journal = JsonlJournal::open(&state).expect("revalidation fixture writer");
    journal
        .append(&event("evt-same"), signals::at(0))
        .expect("revalidation fixture initial append");

    let commit_path = state.join(COMMIT_FILE_NAME);
    let mut metadata = fs::read(&commit_path).expect("revalidation fixture commit metadata");
    let marker = b"\"sha256\":\"";
    let start = metadata
        .windows(marker.len())
        .position(|window| window == marker)
        .map(|index| index + marker.len())
        .expect("revalidation fixture digest marker");
    metadata[start] = if metadata[start] == b'0' { b'1' } else { b'0' };
    let mut file = OpenOptions::new()
        .write(true)
        .open(&commit_path)
        .expect("revalidation fixture commit open");
    file.write_all(&metadata)
        .expect("revalidation fixture commit write");
    file.sync_all().expect("revalidation fixture commit sync");

    let before = artifact_snapshot(&state).expect("revalidation fixture before snapshot");
    let result = journal.append(&event("evt-next"), signals::at(1));
    assert_eq!(
        result.as_ref().map_err(JournalError::code),
        Err("JOURNAL_CORRUPT"),
        "same-length committed-prefix corruption must stop append revalidation"
    );
    let after = artifact_snapshot(&state).expect("revalidation fixture after snapshot");
    assert_eq!(
        before, after,
        "failed revalidation must not mutate artifacts"
    );
}

/// Exercise the public reader against a clean image with an unpublished
/// journal tail. The reader must report an indeterminate image and leave
/// every artifact byte and metadata field untouched. This deliberately uses a
/// CLEAN witness: the PREPARED recovery path has its own prefix validation and
/// would not detect a mutation of the clean-reader tail guard.
fn run_tail_rejection_fixture() {
    let temporary = TempDir::new();
    let state = temporary.state();
    prepare_clean_state(&state).expect("tail fixture setup");
    let mut journal = JsonlJournal::open(&state).expect("tail fixture writer");
    journal
        .append(&event("evt-same"), signals::at(0))
        .expect("tail fixture committed append");
    drop(journal);

    let journal_path = state.join(JOURNAL_FILE_NAME);
    let mut file = OpenOptions::new()
        .append(true)
        .open(&journal_path)
        .expect("tail fixture journal open");
    file.write_all(b"unpublished-tail")
        .expect("tail fixture append");
    file.sync_all().expect("tail fixture sync");

    let before = artifact_snapshot(&state).expect("tail fixture before reader");
    let mut reader = JsonlJournalReader::open(&state).expect("tail fixture reader open");
    let result = reader.load_committed();
    assert!(
        matches!(result, Err(JournalError::OutcomeUnknown { .. })),
        "clean image with an unpublished tail must be unknown, got {result:?}"
    );
    let after = artifact_snapshot(&state).expect("tail fixture after reader");
    assert_eq!(
        before, after,
        "reader tail rejection must not mutate any state artifact"
    );
}

fn run_sentinel(name: &str) {
    assert!(
        MUTATION_SENTINELS.contains(&name),
        "sentinel is not in the closed manifest"
    );
    assert_manifest();
    validate_authorities().expect("named store/classification authorities remain present");
    assert_sentinel_source(name);
    if name == "mutation-append-revalidation-bypass" {
        run_append_revalidation_fixture();
        return;
    }
    if name == "mutation-tail-repair-or-promotion" {
        run_tail_rejection_fixture();
        return;
    }
    let relevant_id = match name {
        "mutation-prepared-barrier-noop" | "mutation-reader-accepts-incomplete-generation" => {
            "init-prepared-barrier"
        }
        "mutation-journal-barrier-noop" | "mutation-commit-before-journal-barrier" => {
            "append-journal-barrier"
        }
        "mutation-commit-temporary-barrier-noop" => "append-commit-temporary-barrier",
        "mutation-commit-directory-barrier-noop" => "append-commit-directory-barrier",
        "mutation-clean-barrier-noop" => "append-clean-barrier",
        _ => unreachable!(),
    };
    let relevant = SCENARIOS
        .iter()
        .find(|scenario| scenario.id == relevant_id)
        .unwrap_or_else(|| panic!("sentinel scenario is missing: {relevant_id}"));
    execute_scenario(relevant).unwrap_or_else(|error| {
        panic!("sentinel {name} did not execute its production scenario: {error}")
    });
}

fn assert_sentinel(name: &str) {
    let result = std::panic::catch_unwind(|| run_sentinel(name));
    assert!(
        result.is_ok(),
        "assertion failure: mutation sentinel {name} detected"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact ignored helper selector used by the parent matrix.
    #[test]
    #[ignore = "invoked only as a bounded child by the crash-matrix parent"]
    fn child_process_entry() {
        let config = HelperConfig::from_environment().expect("valid crash helper environment");
        let result = match config.role {
            Role::Holder | Role::ResponseChild => run_primary(&config),
            Role::Inspector => run_inspector(&config),
            Role::Contender => run_contender(&config),
        };
        if let Err(error) = result {
            panic!("store crash helper {} failed: {error}", config.scenario.id);
        }
    }

    /// Exact required parent selector used by `cargo xtask store-crash-check`.
    #[test]
    #[ignore = "requires the qualified x86_64 GNU/Linux crash-test profile"]
    fn supported_linux_crash_matrix() {
        run_required_matrix().expect("supported Linux store crash matrix");
    }

    #[test]
    fn manifest_has_exact_closed_shape() {
        assert_manifest();
    }

    #[test]
    fn sentinel_prepared_barrier_required() {
        assert_sentinel("mutation-prepared-barrier-noop");
    }

    #[test]
    fn sentinel_journal_barrier_required() {
        assert_sentinel("mutation-journal-barrier-noop");
    }

    #[test]
    fn sentinel_commit_temporary_barrier_required() {
        assert_sentinel("mutation-commit-temporary-barrier-noop");
    }

    #[test]
    fn sentinel_commit_directory_barrier_required() {
        assert_sentinel("mutation-commit-directory-barrier-noop");
    }

    #[test]
    fn sentinel_clean_barrier_required() {
        assert_sentinel("mutation-clean-barrier-noop");
    }

    #[test]
    fn sentinel_commit_follows_journal_barrier() {
        assert_sentinel("mutation-commit-before-journal-barrier");
    }

    #[test]
    fn sentinel_reader_rejects_initialization_prepared() {
        assert_sentinel("mutation-reader-accepts-incomplete-generation");
    }

    #[test]
    fn sentinel_reader_never_promotes_extra_tail() {
        assert_sentinel("mutation-tail-repair-or-promotion");
    }

    #[test]
    fn sentinel_append_revalidates_committed_prefix() {
        assert_sentinel("mutation-append-revalidation-bypass");
    }
}
