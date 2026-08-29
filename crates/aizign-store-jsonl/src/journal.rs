//! The store-v2 durable JSONL journal and its strictly observational reader.

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

use aizign_core::BoundedTimestamp;
use aizign_core::workflow::WorkflowEvent;
use aizign_engine::{Journal, JournalEntry, JournalError, JournalReader, MAX_JOURNAL_ENTRIES};

use crate::commit::{CommitPoint, MAX_COMMIT_METADATA_BYTES, hash_bytes};
use crate::durability::{DurabilityOps, DurabilityPoint, ProductionDurability};
use crate::observation::{BestEffortStoreObserver, StoreObservation, StoreObserver, StoreStage};
use crate::profile::{
    ProductionProfile, ProfileOps, QualifiedProfile, qualify_directory, require_same_profile,
};
use crate::publish::{MAX_PUBLISH_METADATA_BYTES, PublishWitness};
use crate::record;

/// File name of the journal inside the state directory.
pub const JOURNAL_FILE_NAME: &str = "workflow.jsonl";
/// File name of the writer-ownership and reader-snapshot lock.
pub const LOCK_FILE_NAME: &str = "workflow.lock";
/// File name of the writer-published committed-prefix metadata.
pub const COMMIT_FILE_NAME: &str = "workflow.commit.json";
/// File name of the store-v2 PREPARED/CLEAN publication witness.
pub const PUBLISH_FILE_NAME: &str = "workflow.publish.json";
const COMMIT_TEMP_FILE_NAME: &str = "workflow.commit.tmp";

/// Whether this build target has the verified store-profile implementation.
pub const STORE_PLATFORM_SUPPORTED: bool = cfg!(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
));

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "32"
))]
const _: () = assert!(!STORE_PLATFORM_SUPPORTED);

const MAX_JOURNAL_BYTES: u64 = 64 * 1024 * 1024;

/// Append-capable journal. Dropping it releases exclusive ownership.
pub struct JsonlJournal {
    state_dir: PathBuf,
    path: PathBuf,
    lock: JournalLock,
}

/// Strictly observational reader. Dropping it releases the shared lock.
pub struct JsonlJournalReader {
    state_dir: PathBuf,
    path: PathBuf,
    lock: JournalLock,
}

struct JournalLock {
    file: File,
}

/// Append-capable JSONL journal with store-owned physical observations.
pub struct ObservedJsonlJournal<'a> {
    inner: JsonlJournal,
    observer: BestEffortStoreObserver<'a>,
}

/// Read-only JSONL reader with store-owned physical observations.
pub struct ObservedJsonlJournalReader<'a> {
    inner: JsonlJournalReader,
    observer: BestEffortStoreObserver<'a>,
}

struct Snapshot {
    point: CommitPoint,
    bytes: Vec<u8>,
    entries: Vec<JournalEntry>,
}

impl JournalLock {
    fn acquire_exclusive(file: File) -> Result<Self, JournalError> {
        match file.try_lock() {
            Ok(()) => Ok(Self { file }),
            Err(std::fs::TryLockError::WouldBlock) => Err(JournalError::Locked),
            Err(std::fs::TryLockError::Error(error)) => {
                Err(unavailable(format!("cannot lock journal: {error}")))
            }
        }
    }

    fn acquire_shared(file: File) -> Result<Self, JournalError> {
        match file.try_lock_shared() {
            Ok(()) => Ok(Self { file }),
            Err(std::fs::TryLockError::WouldBlock) => Err(JournalError::Locked),
            Err(std::fs::TryLockError::Error(error)) => Err(unavailable(format!(
                "cannot lock journal snapshot: {error}"
            ))),
        }
    }
}

impl Drop for JournalLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

impl std::fmt::Debug for JsonlJournal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonlJournal")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for JsonlJournalReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonlJournalReader")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for ObservedJsonlJournal<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ObservedJsonlJournal")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for ObservedJsonlJournalReader<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ObservedJsonlJournalReader")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}

fn unavailable(detail: impl Into<String>) -> JournalError {
    JournalError::Unavailable {
        detail: detail.into(),
    }
}

fn corrupt(detail: impl Into<String>) -> JournalError {
    JournalError::Corrupt {
        detail: detail.into(),
    }
}

fn outcome_unknown(detail: impl Into<String>) -> JournalError {
    JournalError::OutcomeUnknown {
        detail: detail.into(),
    }
}

impl JsonlJournal {
    /// Opens the writer and completes only an authorized empty initialization.
    pub fn open(state_dir: &Path) -> Result<Self, JournalError> {
        let mut durability = ProductionDurability;
        let mut profile = ProductionProfile;
        Self::open_with_ops(state_dir, &mut durability, &mut profile)
    }

    /// Opens the writer while exposing store-owned physical observations.
    pub fn open_observed<'a>(
        state_dir: &Path,
        observer: &'a mut dyn StoreObserver,
    ) -> Result<ObservedJsonlJournal<'a>, JournalError> {
        let mut observer = BestEffortStoreObserver::new(observer);
        observer.observe(StoreObservation::StageStarted(StoreStage::JournalOpen));
        let opened = Self::open(state_dir);
        observer.observe(StoreObservation::StageFinished(StoreStage::JournalOpen));
        let inner = opened?;
        if let Ok(bytes) = fs::metadata(&inner.path).map(|metadata| metadata.len()) {
            observer.observe(StoreObservation::JournalPhysicalBytes(bytes));
        }
        Ok(ObservedJsonlJournal { inner, observer })
    }

    pub(crate) fn open_with_ops(
        state_dir: &Path,
        durability: &mut dyn DurabilityOps,
        profile: &mut dyn ProfileOps,
    ) -> Result<Self, JournalError> {
        if !STORE_PLATFORM_SUPPORTED {
            return Err(unsupported_platform());
        }

        let state_profile = ensure_state_directory(state_dir, durability, profile)?;
        let lock_path = state_dir.join(LOCK_FILE_NAME);
        let journal_path = state_dir.join(JOURNAL_FILE_NAME);
        let commit_path = state_dir.join(COMMIT_FILE_NAME);
        let publish_path = state_dir.join(PUBLISH_FILE_NAME);

        let lock_exists = path_entry_exists(&lock_path)?;
        let journal_exists = path_entry_exists(&journal_path)?;
        let commit_exists = path_entry_exists(&commit_path)?;
        let publish_exists = path_entry_exists(&publish_path)?;
        let any_exists = lock_exists || journal_exists || commit_exists || publish_exists;

        if any_exists && !(lock_exists && journal_exists && commit_exists) {
            return Err(unavailable(
                "partial pre-marker store state is unsupported and must be discarded",
            ));
        }

        if !lock_exists {
            durability_note(durability, DurabilityPoint::LockFileCreate, false)?;
        }
        let lock_file = open_private_update_file(&lock_path, !lock_exists)?;
        require_same_profile(&lock_file, &state_profile, profile)?;
        let lock = JournalLock::acquire_exclusive(lock_file)?;

        if !journal_exists {
            durability_note(durability, DurabilityPoint::JournalFileCreate, false)?;
        }
        let journal = open_private_append_file(&journal_path, !journal_exists)?;
        require_same_profile(&journal, &state_profile, profile)?;

        if any_exists {
            let mut commit = open_private_read_file(&commit_path)?;
            require_same_profile(&commit, &state_profile, profile)?;
            let point = read_commit_point(&mut commit)?;
            if publish_exists {
                resume_or_validate_existing(state_dir, &state_profile, durability, profile)?;
            } else {
                if point != CommitPoint::empty() || file_len(&journal)? != 0 {
                    return Err(unavailable(
                        "v2 commit metadata exists without its publication witness",
                    ));
                }
                initialize_witness(
                    state_dir,
                    &state_profile,
                    &publish_path,
                    durability,
                    profile,
                )?;
            }
        } else {
            initialize_fresh_store(
                state_dir,
                &state_profile,
                &lock,
                &journal,
                durability,
                profile,
            )?;
        }

        Ok(Self {
            state_dir: state_dir.to_path_buf(),
            path: journal_path,
            lock,
        })
    }

    pub(crate) fn append_with_ops(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
        durability: &mut dyn DurabilityOps,
        profile: &mut dyn ProfileOps,
        mut observer: Option<&mut dyn StoreObserver>,
    ) -> Result<JournalEntry, JournalError> {
        let state_directory = open_existing_private_dir(&self.state_dir)?;
        let state_profile = qualify_directory(&state_directory, profile)?;
        revalidate_lock(&self.state_dir, &self.lock, &state_profile, profile)?;
        let mut snapshot =
            read_snapshot_observed(&self.state_dir, &state_profile, profile, &mut observer)?;
        if snapshot.point.generation == MAX_JOURNAL_ENTRIES as u64 + 1 {
            return Err(JournalError::BoundExceeded {
                max: MAX_JOURNAL_ENTRIES,
            });
        }

        let publish_path = self.state_dir.join(PUBLISH_FILE_NAME);
        let journal_path = self.state_dir.join(JOURNAL_FILE_NAME);
        let commit_path = self.state_dir.join(COMMIT_FILE_NAME);
        let mut witness_file = open_private_update_file(&publish_path, false)?;
        require_same_profile(&witness_file, &state_profile, profile)?;
        let current_witness = read_publish_witness(&mut witness_file)?;
        if current_witness != PublishWitness::clean(snapshot.point.generation) {
            return Err(corrupt(
                "publication witness changed after append revalidation",
            ));
        }

        let mut journal_file = open_private_append_file(&journal_path, false)?;
        require_same_profile(&journal_file, &state_profile, profile)?;
        let next_generation = snapshot.point.generation + 1;
        let prepared = PublishWitness::prepared(next_generation);

        rewrite_witness(
            &mut witness_file,
            prepared,
            DurabilityPoint::PreparedWriteComplete,
            DurabilityPoint::PreparedBarrierComplete,
            durability,
            true,
        )?;
        verify_opened_witness(&mut witness_file, prepared)
            .map_err(|error| outcome_unknown(format!("PREPARED verification failed: {error}")))?;

        let seq = snapshot.entries.len() as u64 + 1;
        let entry = JournalEntry {
            seq,
            at,
            event: event.clone(),
        };
        let mut line = record::encode_entry(&entry)?.into_bytes();
        line.push(b'\n');
        durability
            .append_file(
                &mut journal_file,
                &line,
                DurabilityPoint::JournalRecordWriteComplete,
            )
            .map_err(|error| outcome_unknown(format!("journal write failed: {error}")))?;
        durability
            .barrier_file(&journal_file, DurabilityPoint::JournalBarrierComplete)
            .map_err(|error| outcome_unknown(format!("journal barrier failed: {error}")))?;

        snapshot.bytes.extend_from_slice(&line);
        let next_point = observe_stage(&mut observer, StoreStage::PublishPrefixHash, || {
            CommitPoint::for_prefix(&snapshot.bytes, seq)
        });
        publish_commit(
            &self.state_dir,
            &state_profile,
            &commit_path,
            &next_point,
            durability,
            profile,
            true,
        )?;

        let clean = PublishWitness::clean(next_generation);
        rewrite_witness(
            &mut witness_file,
            clean,
            DurabilityPoint::CleanWriteComplete,
            DurabilityPoint::CleanBarrierComplete,
            durability,
            true,
        )?;
        verify_opened_witness(&mut witness_file, clean)
            .map_err(|error| outcome_unknown(format!("CLEAN verification failed: {error}")))?;
        durability
            .note(DurabilityPoint::DurableAppendComplete)
            .map_err(|error| outcome_unknown(format!("append completion failed: {error}")))?;
        Ok(entry)
    }

    fn load_committed_observed_by_store(
        &mut self,
        observer: &mut dyn StoreObserver,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        let mut profile = ProductionProfile;
        let directory = open_existing_private_dir(&self.state_dir)?;
        let state_profile = qualify_directory(&directory, &mut profile)?;
        revalidate_lock(&self.state_dir, &self.lock, &state_profile, &mut profile)?;
        let mut observer = Some(observer);
        read_snapshot_observed(&self.state_dir, &state_profile, &mut profile, &mut observer)
            .map(|snapshot| snapshot.entries)
    }
}

impl JsonlJournalReader {
    /// Opens an existing store without creating, synchronizing, or repairing it.
    pub fn open(state_dir: &Path) -> Result<Self, JournalError> {
        let mut profile = ProductionProfile;
        Self::open_with_profile(state_dir, &mut profile)
    }

    pub(crate) fn open_with_profile(
        state_dir: &Path,
        profile: &mut dyn ProfileOps,
    ) -> Result<Self, JournalError> {
        if !STORE_PLATFORM_SUPPORTED {
            return Err(unsupported_platform());
        }
        let directory = open_existing_private_dir(state_dir)?;
        let state_profile = qualify_directory(&directory, profile)?;
        let lock_path = state_dir.join(LOCK_FILE_NAME);
        let journal_path = state_dir.join(JOURNAL_FILE_NAME);
        let commit_path = state_dir.join(COMMIT_FILE_NAME);
        require_existing_path(&lock_path, "ownership lock")?;
        require_existing_path(&journal_path, "journal")?;
        require_existing_path(&commit_path, "commit metadata")?;
        let lock_file = open_private_read_file(&lock_path)?;
        require_same_profile(&lock_file, &state_profile, profile)?;
        let lock = JournalLock::acquire_shared(lock_file)?;

        let mut commit = open_private_read_file(&commit_path)?;
        require_same_profile(&commit, &state_profile, profile)?;
        let _ = read_commit_point(&mut commit)?;
        require_existing_path(&state_dir.join(PUBLISH_FILE_NAME), "publication witness")?;
        Ok(Self {
            state_dir: state_dir.to_path_buf(),
            path: journal_path,
            lock,
        })
    }

    /// Opens a strictly observational reader with store-owned observations.
    pub fn open_observed<'a>(
        state_dir: &Path,
        observer: &'a mut dyn StoreObserver,
    ) -> Result<ObservedJsonlJournalReader<'a>, JournalError> {
        let mut observer = BestEffortStoreObserver::new(observer);
        observer.observe(StoreObservation::StageStarted(StoreStage::JournalOpen));
        let opened = Self::open(state_dir);
        observer.observe(StoreObservation::StageFinished(StoreStage::JournalOpen));
        let inner = opened?;
        if let Ok(bytes) = fs::metadata(&inner.path).map(|metadata| metadata.len()) {
            observer.observe(StoreObservation::JournalPhysicalBytes(bytes));
        }
        Ok(ObservedJsonlJournalReader { inner, observer })
    }

    fn load_committed_observed_by_store(
        &mut self,
        observer: &mut dyn StoreObserver,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        let directory = open_existing_private_dir(&self.state_dir)?;
        let mut profile = ProductionProfile;
        let state_profile = qualify_directory(&directory, &mut profile)?;
        revalidate_lock(&self.state_dir, &self.lock, &state_profile, &mut profile)?;
        let mut observer = Some(observer);
        read_snapshot_observed(&self.state_dir, &state_profile, &mut profile, &mut observer)
            .map(|snapshot| snapshot.entries)
    }
}

impl JournalReader for JsonlJournalReader {
    fn load_committed(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        let mut profile = ProductionProfile;
        self.load_committed_with_profile(&mut profile)
    }
}

impl JsonlJournalReader {
    pub(crate) fn load_committed_with_profile(
        &mut self,
        profile: &mut dyn ProfileOps,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        let directory = open_existing_private_dir(&self.state_dir)?;
        let state_profile = qualify_directory(&directory, profile)?;
        revalidate_lock(&self.state_dir, &self.lock, &state_profile, profile)?;
        read_snapshot(&self.state_dir, &state_profile, profile).map(|snapshot| snapshot.entries)
    }
}

impl JournalReader for JsonlJournal {
    fn load_committed(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        let directory = open_existing_private_dir(&self.state_dir)?;
        let mut profile = ProductionProfile;
        let state_profile = qualify_directory(&directory, &mut profile)?;
        revalidate_lock(&self.state_dir, &self.lock, &state_profile, &mut profile)?;
        read_snapshot(&self.state_dir, &state_profile, &mut profile)
            .map(|snapshot| snapshot.entries)
    }
}

impl Journal for JsonlJournal {
    fn append(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
    ) -> Result<JournalEntry, JournalError> {
        let mut durability = ProductionDurability;
        let mut profile = ProductionProfile;
        self.append_with_ops(event, at, &mut durability, &mut profile, None)
    }
}

impl JournalReader for ObservedJsonlJournalReader<'_> {
    fn load_committed(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        self.inner
            .load_committed_observed_by_store(&mut self.observer)
    }
}

impl Journal for ObservedJsonlJournal<'_> {
    fn append(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
    ) -> Result<JournalEntry, JournalError> {
        let mut durability = ProductionDurability;
        let mut profile = ProductionProfile;
        self.inner.append_with_ops(
            event,
            at,
            &mut durability,
            &mut profile,
            Some(&mut self.observer),
        )
    }
}

impl JournalReader for ObservedJsonlJournal<'_> {
    fn load_committed(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        self.inner
            .load_committed_observed_by_store(&mut self.observer)
    }
}

fn initialize_fresh_store(
    state_dir: &Path,
    state_profile: &QualifiedProfile,
    lock: &JournalLock,
    journal: &File,
    durability: &mut dyn DurabilityOps,
    profile: &mut dyn ProfileOps,
) -> Result<(), JournalError> {
    let commit_path = state_dir.join(COMMIT_FILE_NAME);
    let publish_path = state_dir.join(PUBLISH_FILE_NAME);
    durability
        .barrier_file(&lock.file, DurabilityPoint::LockFileBarrier)
        .map_err(|error| unavailable(format!("cannot synchronize lock file: {error}")))?;
    durability
        .barrier_file(journal, DurabilityPoint::JournalFileBarrier)
        .map_err(|error| unavailable(format!("cannot synchronize journal file: {error}")))?;
    barrier_directory(
        state_dir,
        durability,
        DurabilityPoint::ArtifactDirectoryBarrier,
        false,
    )?;
    publish_commit(
        state_dir,
        state_profile,
        &commit_path,
        &CommitPoint::empty(),
        durability,
        profile,
        false,
    )?;
    initialize_witness(state_dir, state_profile, &publish_path, durability, profile)
}

fn revalidate_lock(
    state_dir: &Path,
    lock: &JournalLock,
    state_profile: &QualifiedProfile,
    profile: &mut dyn ProfileOps,
) -> Result<(), JournalError> {
    let lock_path = state_dir.join(LOCK_FILE_NAME);
    let reopened = open_private_read_file(&lock_path)?;
    require_same_profile(&lock.file, state_profile, profile)?;
    require_same_profile(&reopened, state_profile, profile)?;
    if opened_identity(&lock.file)? != opened_identity(&reopened)? {
        return Err(unavailable(
            "ownership lock path no longer names the held lock artifact",
        ));
    }
    Ok(())
}

fn initialize_witness(
    state_dir: &Path,
    state_profile: &QualifiedProfile,
    publish_path: &Path,
    durability: &mut dyn DurabilityOps,
    profile: &mut dyn ProfileOps,
) -> Result<(), JournalError> {
    durability_note(durability, DurabilityPoint::WitnessCreate, false)?;
    let mut witness = open_private_update_file(publish_path, true)?;
    require_same_profile(&witness, state_profile, profile)?;
    let identity = opened_identity(&witness)?;
    rewrite_witness(
        &mut witness,
        PublishWitness::initializing(),
        DurabilityPoint::PreparedWriteComplete,
        DurabilityPoint::PreparedBarrierComplete,
        durability,
        false,
    )?;
    verify_opened_witness(&mut witness, PublishWitness::initializing())?;
    barrier_directory(
        state_dir,
        durability,
        DurabilityPoint::WitnessDirectoryBarrierComplete,
        false,
    )?;
    let mut reopened = open_private_update_file(publish_path, false)?;
    require_same_profile(&reopened, state_profile, profile)?;
    if opened_identity(&reopened)? != identity {
        return Err(unavailable(
            "publication witness changed during initialization revalidation",
        ));
    }
    verify_opened_witness(&mut reopened, PublishWitness::initializing())?;
    rewrite_witness(
        &mut reopened,
        PublishWitness::clean(1),
        DurabilityPoint::CleanWriteComplete,
        DurabilityPoint::CleanBarrierComplete,
        durability,
        false,
    )?;
    verify_opened_witness(&mut reopened, PublishWitness::clean(1))
}

fn resume_or_validate_existing(
    state_dir: &Path,
    state_profile: &QualifiedProfile,
    durability: &mut dyn DurabilityOps,
    profile: &mut dyn ProfileOps,
) -> Result<(), JournalError> {
    let commit_path = state_dir.join(COMMIT_FILE_NAME);
    let publish_path = state_dir.join(PUBLISH_FILE_NAME);
    let journal_path = state_dir.join(JOURNAL_FILE_NAME);
    let mut commit_file = open_private_read_file(&commit_path)?;
    require_same_profile(&commit_file, state_profile, profile)?;
    let point = read_commit_point(&mut commit_file)?;
    let mut witness_file = open_private_update_file(&publish_path, false)?;
    require_same_profile(&witness_file, state_profile, profile)?;
    let witness = read_publish_witness(&mut witness_file)?;
    if witness.is_initializing() {
        if point != CommitPoint::empty() || file_len_path(&journal_path)? != 0 {
            return Err(corrupt(
                "initialization PREPARED requires an exact empty commit and journal",
            ));
        }
        let identity = opened_identity(&witness_file)?;
        durability
            .barrier_file(&witness_file, DurabilityPoint::PreparedBarrierComplete)
            .map_err(|error| unavailable(format!("cannot rebarrier PREPARED witness: {error}")))?;
        verify_opened_witness(&mut witness_file, PublishWitness::initializing())?;
        barrier_directory(
            state_dir,
            durability,
            DurabilityPoint::WitnessDirectoryBarrierComplete,
            false,
        )?;
        let mut reopened = open_private_update_file(&publish_path, false)?;
        require_same_profile(&reopened, state_profile, profile)?;
        if opened_identity(&reopened)? != identity {
            return Err(unavailable(
                "publication witness changed during PREPARED revalidation",
            ));
        }
        verify_opened_witness(&mut reopened, PublishWitness::initializing())?;
        rewrite_witness(
            &mut reopened,
            PublishWitness::clean(1),
            DurabilityPoint::CleanWriteComplete,
            DurabilityPoint::CleanBarrierComplete,
            durability,
            false,
        )?;
        return verify_opened_witness(&mut reopened, PublishWitness::clean(1));
    }
    if witness.is_prepared_successor() {
        return Err(outcome_unknown(
            "store is left at a PREPARED publication generation",
        ));
    }
    let _ = read_snapshot(state_dir, state_profile, profile)?;
    Ok(())
}

fn read_snapshot(
    state_dir: &Path,
    state_profile: &QualifiedProfile,
    profile: &mut dyn ProfileOps,
) -> Result<Snapshot, JournalError> {
    read_snapshot_observed(state_dir, state_profile, profile, &mut None)
}

fn read_snapshot_observed(
    state_dir: &Path,
    state_profile: &QualifiedProfile,
    profile: &mut dyn ProfileOps,
    observer: &mut Option<&mut dyn StoreObserver>,
) -> Result<Snapshot, JournalError> {
    let journal_path = state_dir.join(JOURNAL_FILE_NAME);
    let commit_path = state_dir.join(COMMIT_FILE_NAME);
    let publish_path = state_dir.join(PUBLISH_FILE_NAME);

    let mut journal = open_private_read_file(&journal_path)?;
    require_same_profile(&journal, state_profile, profile)?;
    let mut commit = open_private_read_file(&commit_path)?;
    require_same_profile(&commit, state_profile, profile)?;
    let point = read_commit_point(&mut commit)?;
    let mut publish = open_private_read_file(&publish_path)?;
    require_same_profile(&publish, state_profile, profile)?;
    let witness = read_publish_witness(&mut publish)?;
    if witness.is_initializing() {
        if point != CommitPoint::empty() || file_len(&journal)? != 0 {
            return Err(corrupt(
                "initialization PREPARED requires an exact empty commit and journal",
            ));
        }
        return Err(unavailable("store initialization is PREPARED"));
    }
    if witness.is_prepared_successor() {
        return Err(outcome_unknown(
            "store publication is PREPARED and has no known result",
        ));
    }
    if witness != PublishWitness::clean(point.generation) {
        return Err(corrupt(
            "clean witness generation does not match commit generation",
        ));
    }

    let bytes = observe_stage(observer, StoreStage::CommittedPrefixRead, || {
        let physical_len = file_len(&journal)?;
        if physical_len > point.committed_bytes {
            return Err(outcome_unknown(
                "journal contains bytes beyond the clean commit point",
            ));
        }
        if physical_len < point.committed_bytes {
            return Err(corrupt("journal is shorter than committedBytes"));
        }
        journal
            .seek(SeekFrom::Start(0))
            .map_err(|error| unavailable(format!("cannot rewind journal: {error}")))?;
        let mut bytes = Vec::with_capacity(usize::try_from(physical_len).unwrap_or(0));
        std::io::Read::by_ref(&mut journal)
            .take(point.committed_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| unavailable(format!("cannot read journal: {error}")))?;
        if bytes.len() as u64 != point.committed_bytes {
            return Err(corrupt(
                "journal length changed while reading its committed prefix",
            ));
        }
        Ok(bytes)
    })?;
    let digest = observe_stage(observer, StoreStage::CommittedPrefixHash, || {
        hash_bytes(&bytes)
    });
    if digest != point.digest {
        return Err(corrupt(
            "journal prefix does not match the published SHA-256 digest",
        ));
    }
    let entries = observe_stage(observer, StoreStage::CommittedPrefixDecode, || {
        let contents =
            core::str::from_utf8(&bytes).map_err(|_| corrupt("journal is not UTF-8 text"))?;
        let entries = decode_contents(contents)?;
        if entries.len() as u64 != point.committed_entries {
            return Err(corrupt(
                "decoded entry count does not match committedEntries",
            ));
        }
        Ok(entries)
    })?;
    Ok(Snapshot {
        point,
        bytes,
        entries,
    })
}

fn publish_commit(
    state_dir: &Path,
    state_profile: &QualifiedProfile,
    commit_path: &Path,
    point: &CommitPoint,
    durability: &mut dyn DurabilityOps,
    profile: &mut dyn ProfileOps,
    outcome_may_be_unknown: bool,
) -> Result<(), JournalError> {
    let map = |detail: String| {
        if outcome_may_be_unknown {
            outcome_unknown(detail)
        } else {
            unavailable(detail)
        }
    };
    let temp_path = state_dir.join(COMMIT_TEMP_FILE_NAME);
    durability
        .note(DurabilityPoint::CommitTemporaryCreate)
        .map_err(|error| map(format!("cannot begin commit temporary file: {error}")))?;
    let mut temp = open_private_replace_file(&temp_path)
        .map_err(|error| map(format!("cannot create commit temporary file: {error}")))?;
    require_same_profile(&temp, state_profile, profile)
        .map_err(|error| map(format!("commit temporary profile failed: {error}")))?;
    durability
        .write_file(
            &mut temp,
            &point.encode(),
            DurabilityPoint::CommitTemporaryWriteComplete,
        )
        .map_err(|error| map(format!("cannot write commit metadata: {error}")))?;
    durability
        .barrier_file(&temp, DurabilityPoint::CommitTemporaryBarrierComplete)
        .map_err(|error| map(format!("cannot synchronize commit metadata: {error}")))?;
    durability
        .rename(
            &temp_path,
            commit_path,
            DurabilityPoint::CommitRenameComplete,
        )
        .map_err(|error| map(format!("cannot publish commit metadata: {error}")))?;
    barrier_directory(
        state_dir,
        durability,
        DurabilityPoint::CommitDirectoryBarrierComplete,
        outcome_may_be_unknown,
    )?;
    let mut published = open_private_read_file(commit_path)
        .map_err(|error| map(format!("cannot reopen commit metadata: {error}")))?;
    require_same_profile(&published, state_profile, profile)
        .map_err(|error| map(format!("published commit profile failed: {error}")))?;
    let decoded = read_commit_point(&mut published)
        .map_err(|error| map(format!("cannot verify published commit metadata: {error}")))?;
    if decoded != *point {
        return Err(map("published commit metadata changed".to_owned()));
    }
    Ok(())
}

fn rewrite_witness(
    file: &mut File,
    witness: PublishWitness,
    write_point: DurabilityPoint,
    barrier_point: DurabilityPoint,
    durability: &mut dyn DurabilityOps,
    outcome_may_be_unknown: bool,
) -> Result<(), JournalError> {
    let classify = |detail: String| {
        if outcome_may_be_unknown {
            outcome_unknown(detail)
        } else {
            unavailable(detail)
        }
    };
    durability
        .rewrite_file(file, &witness.encode(), write_point)
        .map_err(|error| classify(format!("cannot rewrite publication witness: {error}")))?;
    durability
        .barrier_file(file, barrier_point)
        .map_err(|error| classify(format!("cannot synchronize publication witness: {error}")))
}

fn barrier_directory(
    path: &Path,
    durability: &mut dyn DurabilityOps,
    point: DurabilityPoint,
    outcome_may_be_unknown: bool,
) -> Result<(), JournalError> {
    let directory = open_directory_no_follow(path)?;
    durability
        .barrier_directory(&directory, point)
        .map_err(|error| {
            let detail = format!("cannot synchronize directory: {error}");
            if outcome_may_be_unknown {
                outcome_unknown(detail)
            } else {
                unavailable(detail)
            }
        })
}

fn durability_note(
    durability: &mut dyn DurabilityOps,
    point: DurabilityPoint,
    outcome_may_be_unknown: bool,
) -> Result<(), JournalError> {
    durability.note(point).map_err(|error| {
        let detail = format!("store operation failed: {error}");
        if outcome_may_be_unknown {
            outcome_unknown(detail)
        } else {
            unavailable(detail)
        }
    })
}

fn read_commit_point(file: &mut File) -> Result<CommitPoint, JournalError> {
    let bytes = read_bounded_file(file, MAX_COMMIT_METADATA_BYTES, "commit metadata")?;
    CommitPoint::decode(&bytes, MAX_JOURNAL_BYTES)
}

fn read_publish_witness(file: &mut File) -> Result<PublishWitness, JournalError> {
    let bytes = read_bounded_file(file, MAX_PUBLISH_METADATA_BYTES, "publication witness")?;
    PublishWitness::decode(&bytes)
}

fn verify_opened_witness(file: &mut File, expected: PublishWitness) -> Result<(), JournalError> {
    let actual = read_publish_witness(file)?;
    if actual != expected {
        return Err(corrupt("publication witness changed during verification"));
    }
    Ok(())
}

fn read_bounded_file(file: &mut File, maximum: u64, label: &str) -> Result<Vec<u8>, JournalError> {
    let length = file
        .metadata()
        .map_err(|error| unavailable(format!("cannot stat {label}: {error}")))?
        .len();
    if length > maximum {
        return Err(corrupt(format!("{label} exceeds its byte bound")));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| unavailable(format!("cannot rewind {label}: {error}")))?;
    let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
    std::io::Read::by_ref(file)
        .take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| unavailable(format!("cannot read {label}: {error}")))?;
    if bytes.len() as u64 > maximum {
        return Err(corrupt(format!("{label} exceeds its byte bound")));
    }
    Ok(bytes)
}

fn decode_contents(contents: &str) -> Result<Vec<JournalEntry>, JournalError> {
    if contents.is_empty() {
        return Ok(Vec::new());
    }
    if !contents.ends_with('\n') {
        return Err(corrupt("trailing record is truncated (no final newline)"));
    }
    let mut entries = Vec::new();
    for (index, line) in contents[..contents.len() - 1].split('\n').enumerate() {
        if entries.len() >= MAX_JOURNAL_ENTRIES {
            return Err(JournalError::BoundExceeded {
                max: MAX_JOURNAL_ENTRIES,
            });
        }
        let line_number = index + 1;
        let entry = record::decode_line(line_number, line)?;
        let expected_seq = entries.len() as u64 + 1;
        if entry.seq != expected_seq {
            return Err(corrupt(format!(
                "line {line_number}: seq {} but {expected_seq} expected",
                entry.seq
            )));
        }
        entries.push(entry);
    }
    Ok(entries)
}

fn observe_stage<T>(
    observer: &mut Option<&mut dyn StoreObserver>,
    stage: StoreStage,
    operation: impl FnOnce() -> T,
) -> T {
    if let Some(observer) = observer.as_deref_mut() {
        observer.observe(StoreObservation::StageStarted(stage));
    }
    let result = operation();
    if let Some(observer) = observer.as_deref_mut() {
        observer.observe(StoreObservation::StageFinished(stage));
    }
    result
}

fn unsupported_platform() -> JournalError {
    unavailable("this platform has no verified store-profile implementation")
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn ensure_state_directory(
    dir: &Path,
    durability: &mut dyn DurabilityOps,
    profile: &mut dyn ProfileOps,
) -> Result<QualifiedProfile, JournalError> {
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};

    if path_entry_exists(dir)? {
        let opened = open_existing_private_dir(dir)?;
        return qualify_directory(&opened, profile);
    }

    let parent = nearest_existing_parent(dir)?;
    let parent_directory = open_directory_no_follow(&parent)?;
    let parent_profile = qualify_directory(&parent_directory, profile)?;
    durability_note(durability, DurabilityPoint::StateDirectoryCreate, false)?;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(dir)
        .map_err(|error| unavailable(format!("cannot create state directory: {error}")))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| unavailable(format!("cannot normalize state directory: {error}")))?;
    let state_directory = open_existing_private_dir(dir)?;
    let state_profile = qualify_directory(&state_directory, profile)?;
    require_same_profile(&state_directory, &parent_profile, profile)?;
    durability
        .barrier_directory(&state_directory, DurabilityPoint::StateDirectoryBarrier)
        .map_err(|error| unavailable(format!("cannot synchronize state directory: {error}")))?;
    durability
        .barrier_directory(&parent_directory, DurabilityPoint::ParentDirectoryBarrier)
        .map_err(|error| unavailable(format!("cannot synchronize parent directory: {error}")))?;
    Ok(state_profile)
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn ensure_state_directory(
    _dir: &Path,
    _durability: &mut dyn DurabilityOps,
    _profile: &mut dyn ProfileOps,
) -> Result<QualifiedProfile, JournalError> {
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn nearest_existing_parent(path: &Path) -> Result<PathBuf, JournalError> {
    let mut candidate = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    loop {
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                return Ok(candidate);
            }
            Ok(_) => return Err(unavailable("nearest state parent is not a real directory")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                candidate = candidate
                    .parent()
                    .ok_or_else(|| unavailable("state path has no existing parent"))?
                    .to_path_buf();
            }
            Err(error) => {
                return Err(unavailable(format!(
                    "cannot inspect nearest state parent: {error}"
                )));
            }
        }
    }
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
const O_CLOEXEC: i32 = 0o2_000_000;
#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
const O_DIRECTORY: i32 = 0o200_000;
#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
const O_NOFOLLOW: i32 = 0o400_000;
#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
const O_NONBLOCK: i32 = 0o4_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn path_entry_exists(path: &Path) -> Result<bool, JournalError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(unavailable(format!("cannot inspect path: {error}"))),
    }
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn path_entry_exists(_path: &Path) -> Result<bool, JournalError> {
    Err(unsupported_platform())
}

fn require_existing_path(path: &Path, label: &str) -> Result<(), JournalError> {
    if path_entry_exists(path)? {
        Ok(())
    } else {
        Err(unavailable(format!("store is missing its {label}")))
    }
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn open_existing_private_dir(dir: &Path) -> Result<File, JournalError> {
    use std::os::unix::fs::PermissionsExt as _;

    let metadata = fs::symlink_metadata(dir)
        .map_err(|error| unavailable(format!("cannot stat state directory: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(unavailable("state path must be a real directory"));
    }
    if metadata.permissions().mode() & 0o7777 != 0o700 {
        return Err(unavailable("state directory must have exact mode 0700"));
    }
    open_directory_no_follow(dir)
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn open_existing_private_dir(_dir: &Path) -> Result<File, JournalError> {
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn private_parent_owner(path: &Path) -> Result<u32, JournalError> {
    use std::os::unix::fs::MetadataExt as _;

    let parent = path
        .parent()
        .ok_or_else(|| unavailable("artifact has no state directory"))?;
    let directory = open_existing_private_dir(parent)?;
    directory
        .metadata()
        .map(|metadata| metadata.uid())
        .map_err(|error| unavailable(format!("cannot stat state directory: {error}")))
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn inspect_private_file(path: &Path, owner: u32) -> Result<FileIdentity, JournalError> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = fs::symlink_metadata(path)
        .map_err(|error| unavailable(format!("cannot inspect artifact: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(unavailable("reserved artifact must be a regular file"));
    }
    check_private_metadata(&metadata, owner)?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn check_private_metadata(metadata: &fs::Metadata, owner: u32) -> Result<(), JournalError> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

    if metadata.uid() != owner {
        return Err(unavailable(
            "artifact owner must match the state directory owner",
        ));
    }
    if metadata.nlink() != 1 {
        return Err(unavailable("artifact must have exactly one hard link"));
    }
    if metadata.permissions().mode() & 0o7777 != 0o600 {
        return Err(unavailable("artifact must have exact mode 0600"));
    }
    Ok(())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn configure_secure_file(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt as _;

    options
        .mode(0o600)
        .custom_flags(O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn check_opened_private_file(
    file: &File,
    owner: u32,
    expected: Option<FileIdentity>,
) -> Result<(), JournalError> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = file
        .metadata()
        .map_err(|error| unavailable(format!("cannot stat artifact: {error}")))?;
    if !metadata.file_type().is_file() {
        return Err(unavailable("reserved artifact must be a regular file"));
    }
    check_private_metadata(&metadata, owner)?;
    if let Some(expected) = expected
        && (metadata.dev() != expected.device || metadata.ino() != expected.inode)
    {
        return Err(unavailable("artifact changed while it was opened"));
    }
    Ok(())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn opened_identity(file: &File) -> Result<FileIdentity, JournalError> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = file
        .metadata()
        .map_err(|error| unavailable(format!("cannot stat artifact: {error}")))?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn opened_identity(_file: &File) -> Result<FileIdentity, JournalError> {
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn open_private_read_file(path: &Path) -> Result<File, JournalError> {
    let owner = private_parent_owner(path)?;
    let expected = inspect_private_file(path, owner)?;
    let mut options = OpenOptions::new();
    options.read(true);
    configure_secure_file(&mut options);
    let file = options
        .open(path)
        .map_err(|error| unavailable(format!("cannot open artifact: {error}")))?;
    check_opened_private_file(&file, owner, Some(expected))?;
    Ok(file)
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn open_private_read_file(_path: &Path) -> Result<File, JournalError> {
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn open_private_update_file(path: &Path, create_new: bool) -> Result<File, JournalError> {
    open_private_writable_file(path, create_new, false)
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn open_private_update_file(_path: &Path, _create_new: bool) -> Result<File, JournalError> {
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn open_private_append_file(path: &Path, create_new: bool) -> Result<File, JournalError> {
    open_private_writable_file(path, create_new, true)
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn open_private_append_file(_path: &Path, _create_new: bool) -> Result<File, JournalError> {
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn open_private_writable_file(
    path: &Path,
    create_new: bool,
    append: bool,
) -> Result<File, JournalError> {
    let owner = private_parent_owner(path)?;
    let expected = if create_new {
        if path_entry_exists(path)? {
            return Err(unavailable("reserved artifact appeared while opening"));
        }
        None
    } else {
        Some(inspect_private_file(path, owner)?)
    };
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(!append)
        .append(append)
        .create_new(create_new);
    configure_secure_file(&mut options);
    let file = options
        .open(path)
        .map_err(|error| unavailable(format!("cannot open artifact: {error}")))?;
    if create_new {
        normalize_private_file(&file)?;
    }
    check_opened_private_file(&file, owner, expected)?;
    Ok(file)
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn open_private_replace_file(path: &Path) -> Result<File, JournalError> {
    let owner = private_parent_owner(path)?;
    if path_entry_exists(path)? {
        let expected = inspect_private_file(path, owner)?;
        let mut options = OpenOptions::new();
        options.read(true);
        configure_secure_file(&mut options);
        let stale = options
            .open(path)
            .map_err(|error| unavailable(format!("cannot open stale temporary file: {error}")))?;
        check_opened_private_file(&stale, owner, Some(expected))?;
        fs::remove_file(path)
            .map_err(|error| unavailable(format!("cannot remove stale temporary file: {error}")))?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    configure_secure_file(&mut options);
    let file = options
        .open(path)
        .map_err(|error| unavailable(format!("cannot create temporary file: {error}")))?;
    normalize_private_file(&file)?;
    check_opened_private_file(&file, owner, None)?;
    Ok(file)
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn open_private_replace_file(_path: &Path) -> Result<File, JournalError> {
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn normalize_private_file(file: &File) -> Result<(), JournalError> {
    use std::os::unix::fs::PermissionsExt as _;

    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|error| unavailable(format!("cannot normalize artifact mode: {error}")))
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn open_directory_no_follow(path: &Path) -> Result<File, JournalError> {
    use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};

    let expected = fs::symlink_metadata(path)
        .map_err(|error| unavailable(format!("cannot inspect directory: {error}")))?;
    if expected.file_type().is_symlink() || !expected.file_type().is_dir() {
        return Err(unavailable("directory path must be a real directory"));
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    let directory = options
        .open(path)
        .map_err(|error| unavailable(format!("cannot open directory: {error}")))?;
    let actual = directory
        .metadata()
        .map_err(|error| unavailable(format!("cannot stat opened directory: {error}")))?;
    if !actual.file_type().is_dir()
        || actual.dev() != expected.dev()
        || actual.ino() != expected.ino()
    {
        return Err(unavailable("directory changed while it was opened"));
    }
    Ok(directory)
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn open_directory_no_follow(_path: &Path) -> Result<File, JournalError> {
    Err(unsupported_platform())
}

fn file_len(file: &File) -> Result<u64, JournalError> {
    file.metadata()
        .map(|metadata| metadata.len())
        .map_err(|error| unavailable(format!("cannot stat journal: {error}")))
}

fn file_len_path(path: &Path) -> Result<u64, JournalError> {
    open_private_read_file(path).and_then(|file| file_len(&file))
}
