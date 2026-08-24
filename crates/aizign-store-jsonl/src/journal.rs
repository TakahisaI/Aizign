//! The durable JSONL journal and its strictly read-only committed reader.

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use aizign_core::BoundedTimestamp;
use aizign_core::workflow::WorkflowEvent;
use aizign_engine::{Journal, JournalEntry, JournalError, JournalReader, MAX_JOURNAL_ENTRIES};

use crate::commit::{CommitPoint, MAX_COMMIT_METADATA_BYTES, hash_bytes};
use crate::record;

/// File name of the journal inside the state directory.
pub const JOURNAL_FILE_NAME: &str = "workflow.jsonl";
/// File name of the writer-ownership and reader-snapshot lock.
pub const LOCK_FILE_NAME: &str = "workflow.lock";
/// File name of the writer-published committed-prefix metadata.
pub const COMMIT_FILE_NAME: &str = "workflow.commit.json";
const COMMIT_TEMP_FILE_NAME: &str = "workflow.commit.tmp";

/// Whether this build target has the verified durability implementation.
///
/// `x86_64-unknown-linux-gnu` is the only target covered by the initial
/// contract tests in ADR-0013. Other targets fail closed until equivalent
/// barriers and artifact handling have their own CI coverage.
pub const STORE_PLATFORM_SUPPORTED: bool = cfg!(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
));

// The x32 ABI shares Linux, x86_64, and GNU cfg values with the verified
// target. Keep the public capability gate fail-closed there.
#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "32"
))]
const _: () = assert!(!STORE_PLATFORM_SUPPORTED);

/// Upper bound on the journal file size a cold read will attempt.
const MAX_JOURNAL_BYTES: u64 = 64 * 1024 * 1024;

/// Append-capable journal. Dropping it releases exclusive ownership.
pub struct JsonlJournal {
    state_dir: PathBuf,
    path: PathBuf,
    commit_path: PathBuf,
    file: File,
    _lock: File,
    snapshot: Option<Snapshot>,
}

/// Strictly observational reader of one committed journal snapshot.
pub struct JsonlJournalReader {
    path: PathBuf,
    file: File,
    commit_file: File,
    _lock: File,
}

struct Snapshot {
    bytes: Vec<u8>,
    entries: Vec<JournalEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    )),
    allow(dead_code)
)]
enum DurabilityStep {
    StateDirectoryCreate,
    StateDirectorySync,
    ParentDirectorySync,
    LockFileCreate,
    LockFileSync,
    JournalFileCreate,
    JournalFileSync,
    ArtifactDirectorySync,
    CommitTempCreate,
    CommitTempSync,
    CommitRename,
    CommitDirectorySync,
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

impl JsonlJournal {
    /// Opens the writer, completing only a safe empty initialization when
    /// necessary, and takes the exclusive state lock.
    pub fn open(state_dir: &Path) -> Result<Self, JournalError> {
        Self::open_with_initialization_hook(state_dir, &mut |_| Ok(()))
    }

    fn open_with_initialization_hook<H>(
        state_dir: &Path,
        hook: &mut H,
    ) -> Result<Self, JournalError>
    where
        H: FnMut(DurabilityStep) -> Result<(), JournalError>,
    {
        if !STORE_PLATFORM_SUPPORTED {
            return Err(unsupported_platform());
        }
        ensure_durable_state_dir(state_dir, hook)?;

        let lock_path = state_dir.join(LOCK_FILE_NAME);
        let path = state_dir.join(JOURNAL_FILE_NAME);
        let commit_path = state_dir.join(COMMIT_FILE_NAME);
        let lock_existed = path_entry_exists(&lock_path)?;
        let journal_existed = path_entry_exists(&path)?;
        let commit_existed = path_entry_exists(&commit_path)?;

        if journal_existed && !lock_existed {
            return Err(unavailable("journal exists without its ownership lock"));
        }
        if commit_existed && !journal_existed {
            return Err(unavailable("commit metadata exists without its journal"));
        }

        if !lock_existed {
            hook(DurabilityStep::LockFileCreate)?;
        }
        let lock = open_private_update_file(&lock_path, !lock_existed)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => return Err(JournalError::Locked),
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(unavailable(format!("cannot lock journal: {error}")));
            }
        }

        if !journal_existed {
            hook(DurabilityStep::JournalFileCreate)?;
        }
        let file = open_private_append_file(&path, !journal_existed)?;
        let journal_len = file
            .metadata()
            .map_err(|error| unavailable(format!("cannot stat journal: {error}")))?
            .len();
        if !commit_existed && journal_len != 0 {
            return Err(unavailable(
                "non-empty journal has no committed-prefix metadata; explicit migration or recovery is required",
            ));
        }

        if commit_existed {
            let mut commit_file = open_private_read_file(&commit_path)?;
            let point = read_commit_point(&mut commit_file)?;
            // Opening the writer must reject malformed or impossible commit
            // metadata, but an unpublished tail remains OutcomeUnknown on
            // the first load/append rather than being promoted here.
            if point.committed_bytes > journal_len {
                return Err(corrupt("journal is shorter than committedBytes"));
            }
        } else {
            // File creation and naming become durable before initialization
            // is published. This path may also finish an interrupted empty
            // initialization. A valid existing commit point already proves
            // initialization, so ordinary writer open never synchronizes an
            // unresolved journal tail.
            hook(DurabilityStep::LockFileSync)?;
            lock.sync_all()
                .map_err(|error| unavailable(format!("cannot synchronize lock file: {error}")))?;
            hook(DurabilityStep::JournalFileSync)?;
            file.sync_all().map_err(|error| {
                unavailable(format!("cannot synchronize journal file: {error}"))
            })?;
            hook(DurabilityStep::ArtifactDirectorySync)?;
            sync_directory(state_dir)?;
            publish_commit_with_hook(state_dir, &commit_path, &CommitPoint::empty(), hook)?;
        }

        Ok(Self {
            state_dir: state_dir.to_path_buf(),
            path,
            commit_path,
            file,
            _lock: lock,
            snapshot: None,
        })
    }

    /// Path of the journal file.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn append_with<F, P>(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
        journal_barrier: F,
        publish: P,
    ) -> Result<JournalEntry, JournalError>
    where
        F: FnOnce(&File) -> std::io::Result<()>,
        P: FnOnce(&Path, &Path, &CommitPoint) -> Result<(), JournalError>,
    {
        let mut snapshot = if let Some(snapshot) = self.snapshot.take() {
            snapshot
        } else {
            let mut commit_file = open_private_read_file(&self.commit_path)?;
            read_snapshot(&mut self.file, &mut commit_file)?
        };
        if snapshot.entries.len() >= MAX_JOURNAL_ENTRIES {
            self.snapshot = Some(snapshot);
            return Err(JournalError::BoundExceeded {
                max: MAX_JOURNAL_ENTRIES,
            });
        }
        let seq = snapshot.entries.len() as u64 + 1;
        let entry = JournalEntry {
            seq,
            at,
            event: event.clone(),
        };
        let mut line = record::encode_entry(&entry)?.into_bytes();
        line.push(b'\n');

        // From the first byte onward, a failure cannot be represented as a
        // rejection. The old commit point remains authoritative, and any
        // extra tail is left for explicit recovery.
        self.file
            .write_all(&line)
            .map_err(|error| JournalError::OutcomeUnknown {
                detail: format!("write failed: {error}"),
            })?;
        journal_barrier(&self.file).map_err(|error| JournalError::OutcomeUnknown {
            detail: format!("journal barrier failed: {error}"),
        })?;

        snapshot.bytes.extend_from_slice(&line);
        let point = CommitPoint::for_prefix(&snapshot.bytes, seq);
        publish(&self.state_dir, &self.commit_path, &point).map_err(|error| {
            JournalError::OutcomeUnknown {
                detail: format!("commit publication failed: {error}"),
            }
        })?;
        snapshot.entries.push(entry.clone());
        self.snapshot = Some(snapshot);
        Ok(entry)
    }
}

impl JsonlJournalReader {
    /// Opens an existing initialized store without creating, synchronizing,
    /// repairing, or otherwise changing any state.
    pub fn open(state_dir: &Path) -> Result<Self, JournalError> {
        if !STORE_PLATFORM_SUPPORTED {
            return Err(unsupported_platform());
        }
        ensure_existing_private_dir(state_dir)?;
        let lock_path = state_dir.join(LOCK_FILE_NAME);
        let path = state_dir.join(JOURNAL_FILE_NAME);
        let commit_path = state_dir.join(COMMIT_FILE_NAME);

        // Missing or structurally unsafe snapshot artifacts are unavailable
        // even if another process holds the lock. The secure opens below
        // repeat every check after the lock to close the preflight race.
        require_snapshot_artifacts(&lock_path, &path, &commit_path)?;
        let lock = open_private_read_file(&lock_path)?;
        match lock.try_lock_shared() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => return Err(JournalError::Locked),
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(unavailable(format!(
                    "cannot lock journal snapshot: {error}"
                )));
            }
        }
        let file = open_private_read_file(&path)?;
        let commit_file = open_private_read_file(&commit_path)?;
        Ok(Self {
            path,
            file,
            commit_file,
            _lock: lock,
        })
    }

    /// Path of the journal file.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl JournalReader for JsonlJournalReader {
    fn load_committed(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        read_snapshot(&mut self.file, &mut self.commit_file).map(|snapshot| snapshot.entries)
    }
}

impl JournalReader for JsonlJournal {
    fn load_committed(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        if let Some(snapshot) = &self.snapshot {
            return Ok(snapshot.entries.clone());
        }
        let mut commit_file = open_private_read_file(&self.commit_path)?;
        let snapshot = read_snapshot(&mut self.file, &mut commit_file)?;
        let entries = snapshot.entries.clone();
        self.snapshot = Some(snapshot);
        Ok(entries)
    }
}

impl Journal for JsonlJournal {
    fn append(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
    ) -> Result<JournalEntry, JournalError> {
        self.append_with(event, at, File::sync_all, publish_commit)
    }
}

fn read_snapshot(file: &mut File, commit_file: &mut File) -> Result<Snapshot, JournalError> {
    let point = read_commit_point(commit_file)?;
    let physical_len = file
        .metadata()
        .map_err(|error| unavailable(format!("cannot stat journal: {error}")))?
        .len();
    if physical_len > point.committed_bytes {
        return Err(JournalError::OutcomeUnknown {
            detail: "journal contains bytes beyond the published commit point".to_owned(),
        });
    }
    if physical_len < point.committed_bytes {
        return Err(corrupt("journal is shorter than committedBytes"));
    }

    file.seek(SeekFrom::Start(0))
        .map_err(|error| unavailable(format!("cannot rewind journal: {error}")))?;
    let mut bytes = Vec::with_capacity(usize::try_from(physical_len).unwrap_or(0));
    std::io::Read::by_ref(file)
        .take(point.committed_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| unavailable(format!("cannot read journal: {error}")))?;
    if bytes.len() as u64 > point.committed_bytes {
        return Err(JournalError::OutcomeUnknown {
            detail: "journal grew beyond the published commit point while reading".to_owned(),
        });
    }
    if (bytes.len() as u64) < point.committed_bytes {
        return Err(corrupt(
            "journal became shorter than committedBytes while reading",
        ));
    }
    if hash_bytes(&bytes) != point.digest {
        return Err(corrupt(
            "journal prefix does not match the published SHA-256 digest",
        ));
    }
    let contents =
        core::str::from_utf8(&bytes).map_err(|_| corrupt("journal is not UTF-8 text"))?;
    let entries = decode_contents(contents)?;
    if entries.len() as u64 != point.committed_entries {
        return Err(corrupt(
            "decoded entry count does not match committedEntries",
        ));
    }
    Ok(Snapshot { bytes, entries })
}

fn read_commit_point(file: &mut File) -> Result<CommitPoint, JournalError> {
    let len = file
        .metadata()
        .map_err(|error| unavailable(format!("cannot stat commit metadata: {error}")))?
        .len();
    if len > MAX_COMMIT_METADATA_BYTES {
        return Err(corrupt("commit metadata exceeds its byte bound"));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| unavailable(format!("cannot rewind commit metadata: {error}")))?;
    let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
    std::io::Read::by_ref(file)
        .take(MAX_COMMIT_METADATA_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| unavailable(format!("cannot read commit metadata: {error}")))?;
    if bytes.len() as u64 > MAX_COMMIT_METADATA_BYTES {
        return Err(corrupt("commit metadata exceeds its byte bound"));
    }
    CommitPoint::decode(&bytes, MAX_JOURNAL_BYTES)
}

fn publish_commit(
    state_dir: &Path,
    commit_path: &Path,
    point: &CommitPoint,
) -> Result<(), JournalError> {
    publish_commit_with_hook(state_dir, commit_path, point, &mut |_| Ok(()))
}

fn publish_commit_with_hook<H>(
    state_dir: &Path,
    commit_path: &Path,
    point: &CommitPoint,
    hook: &mut H,
) -> Result<(), JournalError>
where
    H: FnMut(DurabilityStep) -> Result<(), JournalError>,
{
    let temp_path = state_dir.join(COMMIT_TEMP_FILE_NAME);
    hook(DurabilityStep::CommitTempCreate)?;
    let mut temp = open_private_replace_file(&temp_path)?;
    temp.write_all(&point.encode())
        .map_err(|error| unavailable(format!("cannot write commit metadata: {error}")))?;
    hook(DurabilityStep::CommitTempSync)?;
    temp.sync_all()
        .map_err(|error| unavailable(format!("cannot synchronize commit metadata: {error}")))?;
    hook(DurabilityStep::CommitRename)?;
    fs::rename(&temp_path, commit_path)
        .map_err(|error| unavailable(format!("cannot publish commit metadata: {error}")))?;
    hook(DurabilityStep::CommitDirectorySync)?;
    sync_directory(state_dir)
}

/// Decodes a whole committed journal. Every line is a record, the file ends
/// with a newline, and sequence numbers are contiguous from 1.
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

fn unsupported_platform() -> JournalError {
    unavailable("this platform has no verified committed-prefix durability implementation")
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn ensure_durable_state_dir<H>(dir: &Path, hook: &mut H) -> Result<(), JournalError>
where
    H: FnMut(DurabilityStep) -> Result<(), JournalError>,
{
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};

    if path_entry_exists(dir)? {
        ensure_existing_private_dir(dir)?;
    } else {
        hook(DurabilityStep::StateDirectoryCreate)?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(dir)
            .map_err(|error| unavailable(format!("cannot create state directory: {error}")))?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
            unavailable(format!(
                "cannot normalize state directory to mode 0700: {error}"
            ))
        })?;
        let mode = fs::symlink_metadata(dir)
            .map_err(|error| unavailable(format!("cannot stat state directory: {error}")))?
            .permissions()
            .mode()
            & 0o7777;
        if mode != 0o700 {
            return Err(unavailable("state directory must have exact mode 0700"));
        }
    }
    hook(DurabilityStep::StateDirectorySync)?;
    sync_directory(dir)?;
    let parent = dir
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    hook(DurabilityStep::ParentDirectorySync)?;
    sync_directory(parent)
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn ensure_durable_state_dir<H>(_dir: &Path, _hook: &mut H) -> Result<(), JournalError>
where
    H: FnMut(DurabilityStep) -> Result<(), JournalError>,
{
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn ensure_existing_private_dir(dir: &Path) -> Result<(), JournalError> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

    let metadata = fs::symlink_metadata(dir)
        .map_err(|error| unavailable(format!("cannot stat state directory: {error}")))?;
    if metadata.file_type().is_symlink() {
        return Err(unavailable("state directory must not be a symbolic link"));
    }
    if !metadata.is_dir() {
        return Err(unavailable("state path is not a directory"));
    }
    if metadata.permissions().mode() & 0o7777 != 0o700 {
        return Err(unavailable("state directory must have exact mode 0700"));
    }
    let opened = open_directory_no_follow(dir)?;
    let opened_metadata = opened
        .metadata()
        .map_err(|error| unavailable(format!("cannot stat opened state directory: {error}")))?;
    if opened_metadata.dev() != metadata.dev() || opened_metadata.ino() != metadata.ino() {
        return Err(unavailable("state directory changed while it was opened"));
    }
    Ok(())
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn ensure_existing_private_dir(_dir: &Path) -> Result<(), JournalError> {
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn sync_directory(dir: &Path) -> Result<(), JournalError> {
    open_directory_no_follow(dir)?.sync_all().map_err(|error| {
        unavailable(format!(
            "cannot synchronize directory {}: {error}",
            dir.display()
        ))
    })
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn sync_directory(_dir: &Path) -> Result<(), JournalError> {
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
// x86_64 GNU/Linux UAPI values. The support gate and every use of these
// constants must remain restricted to this verified target.
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

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
#[derive(Clone, Copy)]
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
        Err(error) => Err(unavailable(format!(
            "cannot inspect {}: {error}",
            path.display()
        ))),
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
    ensure_existing_private_dir(parent)?;
    fs::symlink_metadata(parent)
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
        .map_err(|error| unavailable(format!("cannot inspect {}: {error}", name_of(path))))?;
    if metadata.file_type().is_symlink() {
        return Err(unavailable(format!(
            "{} must not be a symbolic link",
            name_of(path)
        )));
    }
    if !metadata.file_type().is_file() {
        return Err(unavailable(format!(
            "{} must be a regular file",
            name_of(path)
        )));
    }
    check_private_metadata(path, &metadata, owner)?;
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
fn require_snapshot_artifacts(
    lock_path: &Path,
    journal_path: &Path,
    commit_path: &Path,
) -> Result<(), JournalError> {
    let owner = private_parent_owner(lock_path)?;
    inspect_private_file(lock_path, owner)?;
    inspect_private_file(journal_path, owner)?;
    inspect_private_file(commit_path, owner)?;
    Ok(())
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
fn require_snapshot_artifacts(
    _lock_path: &Path,
    _journal_path: &Path,
    _commit_path: &Path,
) -> Result<(), JournalError> {
    Err(unsupported_platform())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn check_private_metadata(
    path: &Path,
    metadata: &fs::Metadata,
    owner: u32,
) -> Result<(), JournalError> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

    if metadata.uid() != owner {
        return Err(unavailable(format!(
            "{} owner must match the state directory owner",
            name_of(path)
        )));
    }
    if metadata.nlink() != 1 {
        return Err(unavailable(format!(
            "{} must have exactly one hard link",
            name_of(path)
        )));
    }
    if metadata.permissions().mode() & 0o7777 != 0o600 {
        return Err(unavailable(format!(
            "{} must have exact mode 0600",
            name_of(path)
        )));
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
    path: &Path,
    file: &File,
    owner: u32,
    expected: Option<FileIdentity>,
) -> Result<(), JournalError> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = file
        .metadata()
        .map_err(|error| unavailable(format!("cannot stat {}: {error}", name_of(path))))?;
    if !metadata.file_type().is_file() {
        return Err(unavailable(format!(
            "{} must be a regular file",
            name_of(path)
        )));
    }
    check_private_metadata(path, &metadata, owner)?;
    if let Some(expected) = expected
        && (metadata.dev() != expected.device || metadata.ino() != expected.inode)
    {
        return Err(unavailable(format!(
            "{} changed while it was opened",
            name_of(path)
        )));
    }
    Ok(())
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
        .map_err(|error| unavailable(format!("cannot open {}: {error}", name_of(path))))?;
    check_opened_private_file(path, &file, owner, Some(expected))?;
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
            return Err(unavailable(format!(
                "{} appeared while the store was opening",
                name_of(path)
            )));
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
        .map_err(|error| unavailable(format!("cannot open {}: {error}", name_of(path))))?;
    if create_new {
        normalize_private_file(path, &file)?;
    }
    check_opened_private_file(path, &file, owner, expected)?;
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
            .map_err(|error| unavailable(format!("cannot open {}: {error}", name_of(path))))?;
        check_opened_private_file(path, &stale, owner, Some(expected))?;
        fs::remove_file(path).map_err(|error| {
            unavailable(format!("cannot remove stale {}: {error}", name_of(path)))
        })?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    configure_secure_file(&mut options);
    let file = options
        .open(path)
        .map_err(|error| unavailable(format!("cannot create {}: {error}", name_of(path))))?;
    normalize_private_file(path, &file)?;
    check_opened_private_file(path, &file, owner, None)?;
    Ok(file)
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn normalize_private_file(path: &Path, file: &File) -> Result<(), JournalError> {
    use std::os::unix::fs::PermissionsExt as _;

    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|error| {
            unavailable(format!(
                "cannot normalize {} to mode 0600: {error}",
                name_of(path)
            ))
        })
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
fn open_directory_no_follow(path: &Path) -> Result<File, JournalError> {
    use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};

    let expected = fs::symlink_metadata(path).map_err(|error| {
        unavailable(format!(
            "cannot inspect directory {}: {error}",
            path.display()
        ))
    })?;
    if expected.file_type().is_symlink() || !expected.file_type().is_dir() {
        return Err(unavailable(format!(
            "{} must be a real directory",
            path.display()
        )));
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    let directory = options.open(path).map_err(|error| {
        unavailable(format!("cannot open directory {}: {error}", path.display()))
    })?;
    let actual = directory.metadata().map_err(|error| {
        unavailable(format!("cannot stat directory {}: {error}", path.display()))
    })?;
    if !actual.file_type().is_dir()
        || actual.dev() != expected.dev()
        || actual.ino() != expected.ino()
    {
        return Err(unavailable(format!(
            "directory {} changed while it was opened",
            path.display()
        )));
    }
    Ok(directory)
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(all(
    test,
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
mod tests {
    use std::io;
    use std::path::Path;

    use aizign_engine::{JournalError, JournalReader};
    use aizign_testkit::{TempDir, signals};

    use super::{DurabilityStep, JsonlJournal, JsonlJournalReader, publish_commit_with_hook};
    use crate::commit::CommitPoint;

    fn artifact_bytes(state: &Path) -> Vec<(String, Vec<u8>)> {
        if !state.exists() {
            return Vec::new();
        }
        let mut artifacts: Vec<_> = std::fs::read_dir(state)
            .expect("read state")
            .map(|entry| {
                let path = entry.expect("artifact").path();
                (
                    path.file_name()
                        .expect("artifact name")
                        .to_string_lossy()
                        .into_owned(),
                    std::fs::read(path).expect("read artifact"),
                )
            })
            .collect();
        artifacts.sort_by(|left, right| left.0.cmp(&right.0));
        artifacts
    }

    #[test]
    fn every_initialization_creation_and_barrier_failure_is_recoverable() {
        let steps = [
            DurabilityStep::StateDirectoryCreate,
            DurabilityStep::StateDirectorySync,
            DurabilityStep::ParentDirectorySync,
            DurabilityStep::LockFileCreate,
            DurabilityStep::LockFileSync,
            DurabilityStep::JournalFileCreate,
            DurabilityStep::JournalFileSync,
            DurabilityStep::ArtifactDirectorySync,
            DurabilityStep::CommitTempCreate,
            DurabilityStep::CommitTempSync,
            DurabilityStep::CommitRename,
            DurabilityStep::CommitDirectorySync,
        ];
        for failed_step in steps {
            let dir = TempDir::new();
            let state = dir.state();
            let error = JsonlJournal::open_with_initialization_hook(&state, &mut |step| {
                if step == failed_step {
                    Err(JournalError::Unavailable {
                        detail: format!("injected {step:?} failure"),
                    })
                } else {
                    Ok(())
                }
            })
            .expect_err("initialization must report the injected failure");
            assert!(matches!(error, JournalError::Unavailable { .. }));

            let before = artifact_bytes(&state);
            let observed =
                JsonlJournalReader::open(&state).and_then(|mut reader| reader.load_committed());
            if failed_step == DurabilityStep::CommitDirectorySync {
                assert_eq!(observed.expect("visible safe commit point"), Vec::new());
            } else {
                assert!(
                    matches!(observed, Err(JournalError::Unavailable { .. })),
                    "{failed_step:?}: {observed:?}"
                );
            }
            assert_eq!(
                artifact_bytes(&state),
                before,
                "reader changed artifacts after {failed_step:?}"
            );

            drop(JsonlJournal::open(&state).expect("writer completes initialization"));
            let mut reader = JsonlJournalReader::open(&state).expect("open recovered reader");
            assert!(
                reader
                    .load_committed()
                    .expect("recovered snapshot")
                    .is_empty()
            );
        }
    }

    #[test]
    fn barrier_failure_after_complete_write_leaves_an_unpublished_tail() {
        let dir = TempDir::new();
        let state = dir.state();
        let mut journal = JsonlJournal::open(&state).expect("open writer");
        let before_commit = std::fs::read(&journal.commit_path).expect("read commit");
        let error = journal
            .append_with(
                &aizign_core::workflow::WorkflowEvent::SignalAccepted {
                    signal: signals::implementation_ready("evt-unknown"),
                },
                signals::at(0),
                |_| Err(io::Error::other("injected journal barrier failure")),
                |_, _, _: &CommitPoint| panic!("commit must not be published"),
            )
            .expect_err("barrier failure");
        assert!(matches!(error, JournalError::OutcomeUnknown { .. }));
        assert_eq!(
            std::fs::read(&journal.commit_path).expect("read commit"),
            before_commit,
            "the failed append must not move the commit point"
        );
        drop(journal);

        let mut reader = JsonlJournalReader::open(&state).expect("open reader");
        assert!(matches!(
            reader.load_committed(),
            Err(JournalError::OutcomeUnknown { .. })
        ));
    }

    #[test]
    fn publication_failure_after_journal_barrier_does_not_promote_the_tail() {
        let dir = TempDir::new();
        let state = dir.state();
        let mut journal = JsonlJournal::open(&state).expect("open writer");
        let before_commit = std::fs::read(&journal.commit_path).expect("read commit");
        let error = journal
            .append_with(
                &aizign_core::workflow::WorkflowEvent::SignalAccepted {
                    signal: signals::implementation_ready("evt-publish-unknown"),
                },
                signals::at(0),
                std::fs::File::sync_all,
                |_, _, _: &CommitPoint| {
                    Err(JournalError::Unavailable {
                        detail: "injected commit publication failure".to_owned(),
                    })
                },
            )
            .expect_err("publication failure");
        assert!(matches!(error, JournalError::OutcomeUnknown { .. }));
        assert_eq!(
            std::fs::read(&journal.commit_path).expect("read commit"),
            before_commit,
            "the failed publication must not move the commit point"
        );
        drop(journal);

        let mut reader = JsonlJournalReader::open(&state).expect("open reader");
        assert!(matches!(
            reader.load_committed(),
            Err(JournalError::OutcomeUnknown { .. })
        ));
    }

    #[test]
    fn directory_barrier_failure_after_commit_rename_leaves_a_safe_new_point() {
        let dir = TempDir::new();
        let state = dir.state();
        let mut journal = JsonlJournal::open(&state).expect("open writer");
        let error = journal
            .append_with(
                &aizign_core::workflow::WorkflowEvent::SignalAccepted {
                    signal: signals::implementation_ready("evt-visible-commit"),
                },
                signals::at(0),
                std::fs::File::sync_all,
                |state_dir, commit_path, point| {
                    publish_commit_with_hook(state_dir, commit_path, point, &mut |step| {
                        if step == DurabilityStep::CommitDirectorySync {
                            Err(JournalError::Unavailable {
                                detail: "injected commit directory barrier failure".to_owned(),
                            })
                        } else {
                            Ok(())
                        }
                    })
                },
            )
            .expect_err("directory barrier failure");
        assert!(matches!(error, JournalError::OutcomeUnknown { .. }));
        drop(journal);

        let mut reader = JsonlJournalReader::open(&state).expect("open reader");
        let entries = reader
            .load_committed()
            .expect("a visible new commit references an already synchronized prefix");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].event,
            aizign_core::workflow::WorkflowEvent::SignalAccepted {
                signal: signals::implementation_ready("evt-visible-commit")
            }
        );
    }
}
