//! The durable JSONL journal and its strictly read-only committed reader.

use std::fs::{self, File, OpenOptions};
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
        #[cfg(not(unix))]
        return Err(unsupported_platform());
        ensure_durable_state_dir(state_dir, hook)?;

        let lock_path = state_dir.join(LOCK_FILE_NAME);
        let path = state_dir.join(JOURNAL_FILE_NAME);
        let commit_path = state_dir.join(COMMIT_FILE_NAME);
        let lock_existed = lock_path.exists();
        let journal_existed = path.exists();
        let commit_existed = commit_path.exists();

        if journal_existed && !lock_existed {
            return Err(unavailable("journal exists without its ownership lock"));
        }
        if commit_existed && !journal_existed {
            return Err(unavailable("commit metadata exists without its journal"));
        }

        if !lock_existed {
            hook(DurabilityStep::LockFileCreate)?;
        }
        let lock = open_private_update_file(&lock_path, true)?;
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
        let file = open_private_append_file(&path, true)?;
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
        #[cfg(not(unix))]
        return Err(unsupported_platform());
        ensure_existing_private_dir(state_dir)?;
        let lock_path = state_dir.join(LOCK_FILE_NAME);
        let path = state_dir.join(JOURNAL_FILE_NAME);
        let commit_path = state_dir.join(COMMIT_FILE_NAME);

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

#[cfg(not(unix))]
fn unsupported_platform() -> JournalError {
    unavailable("this platform has no verified committed-prefix durability implementation")
}

#[cfg(unix)]
fn ensure_durable_state_dir<H>(dir: &Path, hook: &mut H) -> Result<(), JournalError>
where
    H: FnMut(DurabilityStep) -> Result<(), JournalError>,
{
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};

    if dir.exists() {
        ensure_existing_private_dir(dir)?;
    } else {
        hook(DurabilityStep::StateDirectoryCreate)?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(dir)
            .map_err(|error| unavailable(format!("cannot create state directory: {error}")))?;
        let mode = fs::metadata(dir)
            .map_err(|error| unavailable(format!("cannot stat state directory: {error}")))?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(unavailable(
                "state directory must be owner-only (mode 0700)",
            ));
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

#[cfg(not(unix))]
fn ensure_durable_state_dir<H>(_dir: &Path, _hook: &mut H) -> Result<(), JournalError>
where
    H: FnMut(DurabilityStep) -> Result<(), JournalError>,
{
    Err(unsupported_platform())
}

#[cfg(unix)]
fn ensure_existing_private_dir(dir: &Path) -> Result<(), JournalError> {
    use std::os::unix::fs::PermissionsExt as _;

    let metadata = fs::metadata(dir)
        .map_err(|error| unavailable(format!("cannot stat state directory: {error}")))?;
    if !metadata.is_dir() {
        return Err(unavailable("state path is not a directory"));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(unavailable(
            "state directory must be owner-only (mode 0700)",
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_existing_private_dir(_dir: &Path) -> Result<(), JournalError> {
    Err(unsupported_platform())
}

#[cfg(unix)]
fn sync_directory(dir: &Path) -> Result<(), JournalError> {
    File::open(dir)
        .and_then(|file| file.sync_all())
        .map_err(|error| unavailable(format!("cannot synchronize directory: {error}")))
}

#[cfg(not(unix))]
fn sync_directory(_dir: &Path) -> Result<(), JournalError> {
    Err(unsupported_platform())
}

fn open_private_read_file(path: &Path) -> Result<File, JournalError> {
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|error| unavailable(format!("cannot open {}: {error}", name_of(path))))?;
    check_private_file(path, &file)?;
    Ok(file)
}

fn open_private_update_file(path: &Path, create: bool) -> Result<File, JournalError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(create);
    configure_owner_only(&mut options);
    let file = options
        .open(path)
        .map_err(|error| unavailable(format!("cannot open {}: {error}", name_of(path))))?;
    check_private_file(path, &file)?;
    Ok(file)
}

fn open_private_append_file(path: &Path, create: bool) -> Result<File, JournalError> {
    let mut options = OpenOptions::new();
    options.read(true).append(true).create(create);
    configure_owner_only(&mut options);
    let file = options
        .open(path)
        .map_err(|error| unavailable(format!("cannot open {}: {error}", name_of(path))))?;
    check_private_file(path, &file)?;
    Ok(file)
}

fn open_private_replace_file(path: &Path) -> Result<File, JournalError> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    configure_owner_only(&mut options);
    let file = options
        .open(path)
        .map_err(|error| unavailable(format!("cannot open {}: {error}", name_of(path))))?;
    check_private_file(path, &file)?;
    Ok(file)
}

#[cfg(unix)]
fn configure_owner_only(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt as _;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn configure_owner_only(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn check_private_file(path: &Path, file: &File) -> Result<(), JournalError> {
    use std::os::unix::fs::PermissionsExt as _;

    let mode = file
        .metadata()
        .map_err(|error| unavailable(format!("cannot stat {}: {error}", name_of(path))))?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        return Err(unavailable(format!(
            "{} must be owner-only (mode 0600)",
            name_of(path)
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_private_file(_path: &Path, _file: &File) -> Result<(), JournalError> {
    Err(unsupported_platform())
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
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
