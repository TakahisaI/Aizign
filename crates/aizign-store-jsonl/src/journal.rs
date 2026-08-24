//! The JSONL journal: one state directory, one journal file, one lock file.

use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use aizign_core::BoundedTimestamp;
use aizign_core::workflow::WorkflowEvent;
use aizign_engine::{Journal, JournalEntry, JournalError, MAX_JOURNAL_ENTRIES};

use crate::record;

/// File name of the journal inside the state directory.
pub const JOURNAL_FILE_NAME: &str = "workflow.jsonl";
/// File name of the writer-ownership lock inside the state directory.
pub const LOCK_FILE_NAME: &str = "workflow.lock";

/// Upper bound on the journal file size a cold read will attempt, so a
/// runaway file cannot exhaust memory before the entry bound applies.
const MAX_JOURNAL_BYTES: u64 = 64 * 1024 * 1024;

/// An open JSONL journal. Dropping it releases writer ownership.
pub struct JsonlJournal {
    path: PathBuf,
    file: File,
    _lock: File,
    /// Sequence number the next append will use, once known from a load.
    next_seq: Option<u64>,
}

impl std::fmt::Debug for JsonlJournal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonlJournal")
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
    /// Opens (creating if needed) the journal under `state_dir` and takes
    /// writer ownership.
    ///
    /// The directory and files must be owner-only; on Unix they are created
    /// with modes `0700` / `0600` and existing ones are checked. A second
    /// opener gets [`JournalError::Locked`].
    pub fn open(state_dir: &Path) -> Result<Self, JournalError> {
        ensure_private_dir(state_dir)?;
        let lock = open_private_file(&state_dir.join(LOCK_FILE_NAME))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => return Err(JournalError::Locked),
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(unavailable(format!("cannot lock journal: {error}")));
            }
        }
        let path = state_dir.join(JOURNAL_FILE_NAME);
        let file = open_private_file(&path)?;
        Ok(Self {
            path,
            file,
            _lock: lock,
            next_seq: None,
        })
    }

    /// Path of the journal file.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read_all(&mut self) -> Result<String, JournalError> {
        let len = self
            .file
            .metadata()
            .map_err(|error| unavailable(format!("cannot stat journal: {error}")))?
            .len();
        if len > MAX_JOURNAL_BYTES {
            return Err(JournalError::BoundExceeded {
                max: MAX_JOURNAL_ENTRIES,
            });
        }
        // The handle is shared with appends (which always write at the
        // end), so every cold read starts from the beginning explicitly.
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|error| unavailable(format!("cannot rewind journal: {error}")))?;
        let mut contents = String::new();
        self.file
            .read_to_string(&mut contents)
            .map_err(|error| corrupt(format!("journal is not UTF-8 text: {error}")))?;
        Ok(contents)
    }
}

impl Journal for JsonlJournal {
    fn load(&mut self) -> Result<Vec<JournalEntry>, JournalError> {
        let contents = self.read_all()?;
        let entries = decode_contents(&contents)?;
        self.next_seq = Some(entries.last().map_or(1, |entry| entry.seq + 1));
        Ok(entries)
    }

    fn append(
        &mut self,
        event: &WorkflowEvent,
        at: BoundedTimestamp,
    ) -> Result<JournalEntry, JournalError> {
        let seq = if let Some(seq) = self.next_seq {
            seq
        } else {
            self.load()?;
            self.next_seq.expect("load sets next_seq")
        };
        // The bound is checked before anything is written. A 10001st entry
        // must not reach the file: it would decode fine in isolation but
        // make the very next cold read fail with `BoundExceeded`, turning
        // an acknowledged append into a journal that can no longer load.
        if seq > MAX_JOURNAL_ENTRIES as u64 {
            return Err(JournalError::BoundExceeded {
                max: MAX_JOURNAL_ENTRIES,
            });
        }
        let entry = JournalEntry {
            seq,
            at,
            event: event.clone(),
        };
        let mut line = record::encode_entry(&entry)?;
        line.push('\n');

        // From the first byte written onward, any failure leaves the
        // durable outcome unknown: part of the line may be on disk.
        self.file
            .write_all(line.as_bytes())
            .map_err(|error| JournalError::OutcomeUnknown {
                detail: format!("write failed: {error}"),
            })?;
        self.file
            .sync_data()
            .map_err(|error| JournalError::OutcomeUnknown {
                detail: format!("fsync failed: {error}"),
            })?;
        self.next_seq = Some(seq + 1);
        Ok(entry)
    }
}

/// Decodes a whole journal: every line is a record, the file ends with a
/// newline, and sequence numbers are contiguous from 1.
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

#[cfg(unix)]
fn ensure_private_dir(dir: &Path) -> Result<(), JournalError> {
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
    if dir.exists() {
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
        return Ok(());
    }
    fs::DirBuilder::new()
        .mode(0o700)
        .create(dir)
        .map_err(|error| unavailable(format!("cannot create state directory: {error}")))
}

#[cfg(not(unix))]
fn ensure_private_dir(dir: &Path) -> Result<(), JournalError> {
    if dir.exists() {
        if !dir.is_dir() {
            return Err(unavailable("state path is not a directory"));
        }
        return Ok(());
    }
    fs::create_dir(dir)
        .map_err(|error| unavailable(format!("cannot create state directory: {error}")))
}

#[cfg(unix)]
fn open_private_file(path: &Path) -> Result<File, JournalError> {
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    let file = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| unavailable(format!("cannot open {}: {error}", name_of(path))))?;
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
    Ok(file)
}

#[cfg(not(unix))]
fn open_private_file(path: &Path) -> Result<File, JournalError> {
    OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(path)
        .map_err(|error| unavailable(format!("cannot open {}: {error}", name_of(path))))
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}
