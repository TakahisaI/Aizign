//! Durable behaviour of the JSONL journal: ownership, permissions, bounded
//! cold reads, and refusal to guess about inconsistent files.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use aizu_core::workflow::{Command, Decision, WorkflowEvent, WorkflowState, decide};
use aizu_engine::{Journal, JournalEntry, JournalError, MAX_JOURNAL_ENTRIES};
use aizu_store_jsonl::{
    JOURNAL_FILE_NAME, JOURNAL_SCHEMA_VERSION, JsonlJournal, LOCK_FILE_NAME, encode_record,
};
use aizu_testkit::{TempDir, journal_contract, signals};

fn journal_file(state: &Path) -> PathBuf {
    state.join(JOURNAL_FILE_NAME)
}

fn event(id: &str) -> WorkflowEvent {
    WorkflowEvent::SignalAccepted {
        signal: signals::implementation_ready(id),
    }
}

fn raw_line(seq: u64, event_id: &str) -> String {
    format!(
        r#"{{"schemaVersion":{JOURNAL_SCHEMA_VERSION},"seq":{seq},"at":1724400000,"kind":"workflow.signal.accepted","signal":{{"eventId":"{event_id}","workflowId":"wf-test","assignmentId":"as-implementation","role":"implementation","artifactRevision":"rev-a","kind":"implementation_ready"}}}}"#
    )
}

fn write_raw(state: &Path, contents: &str) {
    fs::create_dir_all(state).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(state, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options
        .open(journal_file(state))
        .unwrap()
        .write_all(contents.as_bytes())
        .unwrap();
}

#[test]
fn satisfies_the_journal_contract() {
    let dir = TempDir::new();
    let mut journal = JsonlJournal::open(&dir.state()).unwrap();
    journal_contract::run(&mut journal);
}

#[test]
fn creates_an_owner_only_state_directory_and_files() {
    let dir = TempDir::new();
    let state = dir.state();
    let _journal = JsonlJournal::open(&state).unwrap();
    assert!(journal_file(&state).is_file());
    assert!(state.join(LOCK_FILE_NAME).is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(journal_file(&state))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn entries_survive_reopen_and_feed_duplicate_detection() {
    let dir = TempDir::new();
    let state = dir.state();
    {
        let mut journal = JsonlJournal::open(&state).unwrap();
        journal.append(&event("evt-1"), signals::at(0)).unwrap();
    }
    // A new process: cold read, rebuild state, and the same signal is a duplicate.
    let mut journal = JsonlJournal::open(&state).unwrap();
    let entries = journal.load().unwrap();
    assert_eq!(entries.len(), 1);
    let state = WorkflowState::replay(entries.iter().map(|entry| &entry.event)).unwrap();
    let command = Command::SubmitSignal {
        signal: signals::implementation_ready("evt-1"),
        expected: signals::expected(),
    };
    assert!(matches!(
        decide(&state, command),
        Decision::Duplicate { .. }
    ));

    // Appending without an explicit load still continues the sequence.
    let entry = journal.append(&event("evt-2"), signals::at(1)).unwrap();
    assert_eq!(entry.seq, 2);
}

#[test]
fn a_second_opener_is_locked_out_until_the_first_drops() {
    let dir = TempDir::new();
    let state = dir.state();
    let first = JsonlJournal::open(&state).unwrap();
    assert_eq!(JsonlJournal::open(&state).err(), Some(JournalError::Locked));
    drop(first);
    assert!(JsonlJournal::open(&state).is_ok());
}

#[cfg(unix)]
#[test]
fn refuses_directories_and_files_that_are_not_owner_only() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = TempDir::new();
    let state = dir.state();
    fs::create_dir_all(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        JsonlJournal::open(&state),
        Err(JournalError::Unavailable { .. })
    ));

    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    write_raw(&state, "");
    fs::set_permissions(journal_file(&state), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        JsonlJournal::open(&state),
        Err(JournalError::Unavailable { .. })
    ));
}

#[test]
fn truncated_trailing_records_are_corrupt_not_ignored() {
    let dir = TempDir::new();
    let state = dir.state();
    write_raw(
        &state,
        &format!("{}\n{}", raw_line(1, "evt-1"), &raw_line(2, "evt-2")[..40]),
    );
    let mut journal = JsonlJournal::open(&state).unwrap();
    assert!(matches!(journal.load(), Err(JournalError::Corrupt { .. })));
}

#[test]
fn sequence_gaps_and_unknown_fields_are_corrupt() {
    let dir = TempDir::new();
    let state = dir.state();
    write_raw(
        &state,
        &format!("{}\n{}\n", raw_line(1, "evt-1"), raw_line(3, "evt-3")),
    );
    let mut journal = JsonlJournal::open(&state).unwrap();
    let Err(JournalError::Corrupt { detail }) = journal.load() else {
        panic!("gap must be corrupt")
    };
    assert!(detail.contains("seq 3 but 2 expected"), "{detail}");
    drop(journal);

    write_raw(
        &state,
        &format!(
            "{}\n",
            raw_line(1, "evt-1").replace(r#""at":"#, r#""prompt":"x","at":"#)
        ),
    );
    let mut journal = JsonlJournal::open(&state).unwrap();
    assert!(matches!(journal.load(), Err(JournalError::Corrupt { .. })));
}

#[test]
fn unsupported_schema_versions_are_reported() {
    let dir = TempDir::new();
    let state = dir.state();
    write_raw(
        &state,
        &format!(
            "{}\n",
            raw_line(1, "evt-1").replacen(r#""schemaVersion":1"#, r#""schemaVersion":2"#, 1)
        ),
    );
    let mut journal = JsonlJournal::open(&state).unwrap();
    assert_eq!(
        journal.load().err(),
        Some(JournalError::SchemaUnsupported { found: 2 })
    );
}

#[test]
fn cold_reads_are_bounded() {
    let dir = TempDir::new();
    let state = dir.state();
    let mut contents = String::new();
    for seq in 1..=(MAX_JOURNAL_ENTRIES as u64 + 1) {
        contents.push_str(&raw_line(seq, &format!("evt-{seq}")));
        contents.push('\n');
    }
    write_raw(&state, &contents);
    let mut journal = JsonlJournal::open(&state).unwrap();
    assert_eq!(
        journal.load().err(),
        Some(JournalError::BoundExceeded {
            max: MAX_JOURNAL_ENTRIES
        })
    );
}

#[test]
fn the_10001st_append_is_refused_without_touching_the_file() {
    let dir = TempDir::new();
    let state = dir.state();
    let mut journal = JsonlJournal::open(&state).unwrap();
    for (index, seq) in (1..=MAX_JOURNAL_ENTRIES).enumerate() {
        journal
            .append(&event(&format!("evt-{seq}")), signals::at(index as u64))
            .unwrap_or_else(|error| panic!("append {seq}: {error}"));
    }
    let before = fs::read(journal_file(&state)).unwrap();

    // The bound is enforced on append, not only on read: an acknowledged
    // append must never create a journal the next cold read cannot load.
    let refused = journal
        .append(&event("evt-over"), signals::at(0))
        .unwrap_err();
    assert_eq!(
        refused,
        JournalError::BoundExceeded {
            max: MAX_JOURNAL_ENTRIES
        }
    );
    assert_eq!(
        fs::read(journal_file(&state)).unwrap(),
        before,
        "a refused append changes nothing"
    );

    // And the file stays readable, with exactly the accepted entries.
    drop(journal);
    let mut reopened = JsonlJournal::open(&state).unwrap();
    assert_eq!(reopened.load().unwrap().len(), MAX_JOURNAL_ENTRIES);
}

#[test]
fn encode_record_rejects_the_seq_values_the_schema_rejects() {
    for seq in [0, MAX_JOURNAL_ENTRIES as u64 + 1] {
        let entry = JournalEntry {
            seq,
            at: signals::at(0),
            event: event("evt-1"),
        };
        assert_eq!(
            encode_record(&entry).err(),
            Some(JournalError::Corrupt {
                detail: format!(
                    "entry seq {seq} is outside the record range 1..={MAX_JOURNAL_ENTRIES}"
                )
            }),
            "seq {seq}"
        );
    }
}

#[test]
fn the_file_holds_metadata_only() {
    let dir = TempDir::new();
    let state = dir.state();
    let mut journal = JsonlJournal::open(&state).unwrap();
    journal
        .append(
            &WorkflowEvent::SignalAccepted {
                signal: signals::blocked("evt-9", "NO_TOOL"),
            },
            signals::at(0),
        )
        .unwrap();
    let contents = fs::read_to_string(journal_file(&state)).unwrap();
    let record: serde_json::Value = serde_json::from_str(contents.trim_end()).unwrap();
    let mut keys: Vec<&str> = record
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["at", "kind", "schemaVersion", "seq", "signal"]);
    let mut signal_keys: Vec<&str> = record["signal"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    signal_keys.sort_unstable();
    assert_eq!(
        signal_keys,
        [
            "artifactRevision",
            "assignmentId",
            "eventId",
            "kind",
            "role",
            "shortErrorCode",
            "workflowId"
        ]
    );
}
