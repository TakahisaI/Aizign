//! Durable committed-prefix behaviour, locking, permissions, and bounds.

#![cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

use aizign_core::workflow::{Command, Decision, WorkflowEvent, WorkflowState, decide};
use aizign_engine::{Journal, JournalEntry, JournalError, JournalReader, MAX_JOURNAL_ENTRIES};
use aizign_store_jsonl::{
    COMMIT_FILE_NAME, JOURNAL_FILE_NAME, JOURNAL_SCHEMA_VERSION, JsonlJournal, JsonlJournalReader,
    LOCK_FILE_NAME, STORE_METADATA_VERSION, StoreObservation, StoreObserver, StoreStage,
    encode_record,
};
use aizign_testkit::{TempDir, journal_contract, signals};
use sha2::{Digest as _, Sha256};

const COMMIT_TEMP_FILE_NAME: &str = "workflow.commit.tmp";

#[derive(Default)]
struct StoreEventLog {
    events: Vec<StoreObservation>,
}

impl StoreObserver for StoreEventLog {
    fn observe(&mut self, observation: StoreObservation) {
        self.events.push(observation);
    }
}

#[derive(Default)]
struct PanickingStoreObserver {
    calls: usize,
}

impl StoreObserver for PanickingStoreObserver {
    fn observe(&mut self, _observation: StoreObservation) {
        self.calls += 1;
        panic!("injected store observer panic");
    }
}

fn journal_file(state: &Path) -> PathBuf {
    state.join(JOURNAL_FILE_NAME)
}

fn commit_file(state: &Path) -> PathBuf {
    state.join(COMMIT_FILE_NAME)
}

fn event(id: &str) -> WorkflowEvent {
    WorkflowEvent::SignalAccepted {
        signal: signals::implementation_ready(id),
    }
}

fn raw_line(seq: u64, event_id: &str) -> String {
    format!(
        r#"{{"schemaVersion":{JOURNAL_SCHEMA_VERSION},"seq":{seq},"at":1724400000,"kind":"workflow.signal.accepted","signal":{{"eventId":"{event_id}","workflowId":"wf-test","assignmentId":"as-implementation","attemptId":"attempt-implementation","role":"implementation","artifactRevision":"rev-a","candidateDigest":{{"algorithm":"sha256","hex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"kind":"implementation_ready"}}}}"#
    )
}

fn digest_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("write to string");
    }
    encoded
}

fn initialize(state: &Path) {
    drop(JsonlJournal::open(state).expect("initialize journal"));
}

fn create_private_state(state: &Path) {
    fs::create_dir(state).expect("create test state");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(state, fs::Permissions::from_mode(0o700)).expect("private state");
    }
}

fn create_private_file(path: &Path, bytes: &[u8]) {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path).expect("create test artifact");
    file.write_all(bytes).expect("write test artifact");
}

fn create_private_fifo(path: &Path) {
    let status = ProcessCommand::new("mkfifo")
        .args(["--mode=600", path.to_str().expect("UTF-8 test path")])
        .status()
        .expect("run mkfifo");
    assert!(status.success(), "create FIFO at {}", path.display());
}

#[test]
fn observed_writer_emits_store_stages_in_physical_order() {
    let dir = TempDir::new();
    let state = dir.state();
    let mut log = StoreEventLog::default();
    {
        let mut journal = JsonlJournal::open_observed(&state, &mut log).unwrap();
        journal
            .append(&event("evt-observed"), signals::at(0))
            .unwrap();
    }

    assert_eq!(
        log.events,
        vec![
            StoreObservation::StageStarted(StoreStage::JournalOpen),
            StoreObservation::StageFinished(StoreStage::JournalOpen),
            StoreObservation::JournalPhysicalBytes(0),
            StoreObservation::StageStarted(StoreStage::CommittedPrefixRead),
            StoreObservation::StageFinished(StoreStage::CommittedPrefixRead),
            StoreObservation::StageStarted(StoreStage::CommittedPrefixHash),
            StoreObservation::StageFinished(StoreStage::CommittedPrefixHash),
            StoreObservation::StageStarted(StoreStage::CommittedPrefixDecode),
            StoreObservation::StageFinished(StoreStage::CommittedPrefixDecode),
            StoreObservation::StageStarted(StoreStage::PublishPrefixHash),
            StoreObservation::StageFinished(StoreStage::PublishPrefixHash),
        ]
    );
    assert!(fs::metadata(journal_file(&state)).unwrap().len() > 0);
}

#[test]
fn observed_reader_reports_open_bytes_and_reaches_only_stages_it_executes() {
    let dir = TempDir::new();
    let state = dir.state();
    initialize(&state);
    let mut log = StoreEventLog::default();
    {
        let mut reader = JsonlJournalReader::open_observed(&state, &mut log).unwrap();
        let entries = reader.load_committed().unwrap();
        assert!(entries.is_empty());
    }

    assert_eq!(
        log.events,
        vec![
            StoreObservation::StageStarted(StoreStage::JournalOpen),
            StoreObservation::StageFinished(StoreStage::JournalOpen),
            StoreObservation::JournalPhysicalBytes(0),
            StoreObservation::StageStarted(StoreStage::CommittedPrefixRead),
            StoreObservation::StageFinished(StoreStage::CommittedPrefixRead),
            StoreObservation::StageStarted(StoreStage::CommittedPrefixHash),
            StoreObservation::StageFinished(StoreStage::CommittedPrefixHash),
            StoreObservation::StageStarted(StoreStage::CommittedPrefixDecode),
            StoreObservation::StageFinished(StoreStage::CommittedPrefixDecode),
        ]
    );
}

#[test]
fn observed_read_finishes_a_stage_when_the_physical_read_errors() {
    let dir = TempDir::new();
    let state = dir.state();
    initialize(&state);
    fs::write(journal_file(&state), b"unpublished tail\n").unwrap();

    let mut log = StoreEventLog::default();
    let mut reader = JsonlJournalReader::open_observed(&state, &mut log).unwrap();
    assert!(matches!(
        reader.load_committed(),
        Err(JournalError::OutcomeUnknown { .. })
    ));
    assert_eq!(
        log.events,
        vec![
            StoreObservation::StageStarted(StoreStage::JournalOpen),
            StoreObservation::StageFinished(StoreStage::JournalOpen),
            StoreObservation::JournalPhysicalBytes(17),
            StoreObservation::StageStarted(StoreStage::CommittedPrefixRead),
            StoreObservation::StageFinished(StoreStage::CommittedPrefixRead),
        ]
    );
}

#[test]
fn raw_and_observed_paths_have_equivalent_results_and_mutations() {
    let raw_dir = TempDir::new();
    let observed_dir = TempDir::new();
    let raw_state = raw_dir.state();
    let observed_state = observed_dir.state();

    let raw_entry = {
        let mut journal = JsonlJournal::open(&raw_state).unwrap();
        journal
            .append(&event("evt-equivalent"), signals::at(0))
            .unwrap()
    };
    let observed_entry = {
        let mut log = StoreEventLog::default();
        let mut journal = JsonlJournal::open_observed(&observed_state, &mut log).unwrap();
        journal
            .append(&event("evt-equivalent"), signals::at(0))
            .unwrap()
    };

    assert_eq!(raw_entry, observed_entry);
    assert_eq!(
        fs::read(journal_file(&raw_state)).unwrap(),
        fs::read(journal_file(&observed_state)).unwrap()
    );
    assert_eq!(
        fs::read(commit_file(&raw_state)).unwrap(),
        fs::read(commit_file(&observed_state)).unwrap()
    );

    fs::write(journal_file(&raw_state), b"unpublished tail\n").unwrap();
    fs::write(journal_file(&observed_state), b"unpublished tail\n").unwrap();
    let raw_error = JsonlJournalReader::open(&raw_state)
        .and_then(|mut reader| reader.load_committed())
        .unwrap_err();
    let mut log = StoreEventLog::default();
    let observed_error = JsonlJournalReader::open_observed(&observed_state, &mut log)
        .and_then(|mut reader| reader.load_committed())
        .unwrap_err();
    assert_eq!(raw_error, observed_error);
}

#[test]
fn store_observer_panic_cannot_change_the_durable_result() {
    let raw_dir = TempDir::new();
    let observed_dir = TempDir::new();
    let raw_state = raw_dir.state();
    let observed_state = observed_dir.state();

    let raw_entry = JsonlJournal::open(&raw_state)
        .unwrap()
        .append(&event("evt-store-panic"), signals::at(0))
        .unwrap();
    let mut observer = PanickingStoreObserver::default();
    let observed_entry = {
        let mut journal = JsonlJournal::open_observed(&observed_state, &mut observer).unwrap();
        journal
            .append(&event("evt-store-panic"), signals::at(0))
            .unwrap()
    };

    assert_eq!(observer.calls, 1);
    assert_eq!(raw_entry, observed_entry);
    assert_eq!(
        fs::read(journal_file(&raw_state)).unwrap(),
        fs::read(journal_file(&observed_state)).unwrap()
    );
    assert_eq!(
        fs::read(commit_file(&raw_state)).unwrap(),
        fs::read(commit_file(&observed_state)).unwrap()
    );
}

#[test]
fn observed_open_finishes_on_error_without_physical_bytes() {
    let missing = TempDir::new().state();
    let mut log = StoreEventLog::default();
    assert!(matches!(
        JsonlJournalReader::open_observed(&missing, &mut log),
        Err(JournalError::Unavailable { .. })
    ));
    assert_eq!(
        log.events,
        vec![
            StoreObservation::StageStarted(StoreStage::JournalOpen),
            StoreObservation::StageFinished(StoreStage::JournalOpen),
        ]
    );
}

fn safe_partial_initialization(state: &Path) {
    create_private_state(state);
    create_private_file(&state.join(LOCK_FILE_NAME), b"");
    create_private_file(&state.join(JOURNAL_FILE_NAME), b"");
}

fn replace_snapshot(state: &Path, contents: &str, entries: u64) {
    initialize(state);
    fs::write(journal_file(state), contents).expect("write test journal");
    let metadata = serde_json::json!({
        "storeVersion": STORE_METADATA_VERSION,
        "committedBytes": contents.len(),
        "committedEntries": entries,
        "sha256": digest_hex(contents.as_bytes()),
    });
    fs::write(
        commit_file(state),
        serde_json::to_vec(&metadata).expect("encode metadata"),
    )
    .expect("write test metadata");
}

fn read_snapshot(state: &Path) -> Result<Vec<JournalEntry>, JournalError> {
    JsonlJournalReader::open(state)?.load_committed()
}

#[test]
fn satisfies_the_journal_contract() {
    let dir = TempDir::new();
    let mut journal = JsonlJournal::open(&dir.state()).unwrap();
    journal_contract::run(&mut journal);
}

#[test]
fn creates_owner_only_durable_layout_files() {
    let dir = TempDir::new();
    let state = dir.state();
    initialize(&state);
    for name in [LOCK_FILE_NAME, JOURNAL_FILE_NAME, COMMIT_FILE_NAME] {
        assert!(state.join(name).is_file(), "{name}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o7777,
            0o700
        );
        for name in [LOCK_FILE_NAME, JOURNAL_FILE_NAME, COMMIT_FILE_NAME] {
            assert_eq!(
                fs::metadata(state.join(name)).unwrap().permissions().mode() & 0o7777,
                0o600,
                "{name}"
            );
        }
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(commit_file(&state)).unwrap()).unwrap();
    assert_eq!(metadata["storeVersion"], STORE_METADATA_VERSION);
    assert_eq!(metadata["committedBytes"], 0);
    assert_eq!(metadata["committedEntries"], 0);
    assert_eq!(
        metadata["sha256"],
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn entries_survive_reopen_and_feed_duplicate_detection() {
    let dir = TempDir::new();
    let state = dir.state();
    {
        let mut journal = JsonlJournal::open(&state).unwrap();
        journal.append(&event("evt-1"), signals::at(0)).unwrap();
    }
    let entries = read_snapshot(&state).unwrap();
    assert_eq!(entries.len(), 1);
    let rebuilt = WorkflowState::replay(entries.iter().map(|entry| &entry.event)).unwrap();
    assert!(matches!(
        decide(
            &rebuilt,
            Command::SubmitSignal {
                signal: signals::implementation_ready("evt-1"),
                expected: signals::expected(),
            }
        ),
        Decision::Duplicate { .. }
    ));

    let mut journal = JsonlJournal::open(&state).unwrap();
    assert_eq!(
        journal.append(&event("evt-2"), signals::at(1)).unwrap().seq,
        2
    );
}

#[test]
fn reader_is_observational_and_requires_every_existing_artifact() {
    let missing = TempDir::new().state();
    assert!(matches!(
        JsonlJournalReader::open(&missing),
        Err(JournalError::Unavailable { .. })
    ));
    assert!(
        !missing.exists(),
        "reader must not initialize a state directory"
    );

    for missing_name in [LOCK_FILE_NAME, JOURNAL_FILE_NAME, COMMIT_FILE_NAME] {
        let dir = TempDir::new();
        let state = dir.state();
        initialize(&state);
        fs::remove_file(state.join(missing_name)).unwrap();
        let before: Vec<_> = fs::read_dir(&state)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        let result = JsonlJournalReader::open(&state);
        assert!(
            matches!(result, Err(JournalError::Unavailable { .. })),
            "missing {missing_name} returned {result:?}"
        );
        let after: Vec<_> = fs::read_dir(&state)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            after, before,
            "reader changed layout after missing {missing_name}"
        );
    }

    let dir = TempDir::new();
    let state = dir.state();
    let mut writer = JsonlJournal::open(&state).unwrap();
    writer.append(&event("evt-1"), signals::at(0)).unwrap();
    drop(writer);
    let before_lock = fs::read(state.join(LOCK_FILE_NAME)).unwrap();
    let before_journal = fs::read(journal_file(&state)).unwrap();
    let before_commit = fs::read(commit_file(&state)).unwrap();
    assert_eq!(read_snapshot(&state).unwrap().len(), 1);
    assert_eq!(fs::read(state.join(LOCK_FILE_NAME)).unwrap(), before_lock);
    assert_eq!(fs::read(journal_file(&state)).unwrap(), before_journal);
    assert_eq!(fs::read(commit_file(&state)).unwrap(), before_commit);
}

#[test]
fn missing_snapshot_artifact_is_unavailable_before_lock_contention() {
    for missing_name in [LOCK_FILE_NAME, JOURNAL_FILE_NAME, COMMIT_FILE_NAME] {
        let dir = TempDir::new();
        let state = dir.state();
        let writer = JsonlJournal::open(&state).unwrap();
        fs::remove_file(state.join(missing_name)).unwrap();

        let result = JsonlJournalReader::open(&state);
        assert!(
            matches!(result, Err(JournalError::Unavailable { .. })),
            "missing {missing_name} under writer contention returned {result:?}"
        );
        drop(writer);
    }
}

#[test]
fn writer_completes_only_safe_empty_initialization_states() {
    for artifacts in [
        &[][..],
        &[LOCK_FILE_NAME][..],
        &[LOCK_FILE_NAME, JOURNAL_FILE_NAME][..],
    ] {
        let dir = TempDir::new();
        let state = dir.state();
        create_private_state(&state);
        for name in artifacts {
            create_private_file(&state.join(name), b"");
        }
        initialize(&state);
        assert!(read_snapshot(&state).unwrap().is_empty());
    }

    let dir = TempDir::new();
    let state = dir.state();
    create_private_state(&state);
    create_private_file(&state.join(JOURNAL_FILE_NAME), b"");
    assert!(matches!(
        JsonlJournal::open(&state),
        Err(JournalError::Unavailable { .. })
    ));

    let dir = TempDir::new();
    let state = dir.state();
    create_private_state(&state);
    create_private_file(&state.join(LOCK_FILE_NAME), b"");
    create_private_file(&state.join(JOURNAL_FILE_NAME), b"unpublished bytes");
    assert!(matches!(
        JsonlJournal::open(&state),
        Err(JournalError::Unavailable { .. })
    ));
    assert!(!state.join(COMMIT_FILE_NAME).exists());

    let dir = TempDir::new();
    let state = dir.state();
    create_private_state(&state);
    create_private_file(&state.join(LOCK_FILE_NAME), b"");
    create_private_file(&state.join(COMMIT_FILE_NAME), b"{}");
    assert!(matches!(
        JsonlJournal::open(&state),
        Err(JournalError::Unavailable { .. })
    ));
}

#[test]
fn shared_readers_and_exclusive_writer_obey_nonblocking_locking() {
    let dir = TempDir::new();
    let state = dir.state();
    initialize(&state);

    let first_reader = JsonlJournalReader::open(&state).unwrap();
    let second_reader = JsonlJournalReader::open(&state).unwrap();
    assert_eq!(JsonlJournal::open(&state).err(), Some(JournalError::Locked));
    drop(first_reader);
    drop(second_reader);

    let writer = JsonlJournal::open(&state).unwrap();
    assert_eq!(
        JsonlJournalReader::open(&state).err(),
        Some(JournalError::Locked)
    );
    assert_eq!(JsonlJournal::open(&state).err(), Some(JournalError::Locked));
    drop(writer);
    assert!(JsonlJournalReader::open(&state).is_ok());
}

#[cfg(unix)]
#[test]
fn refuses_directories_and_files_without_exact_private_modes() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = TempDir::new();
    let state = dir.state();
    fs::create_dir_all(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        JsonlJournal::open(&state),
        Err(JournalError::Unavailable { .. })
    ));

    fs::set_permissions(&state, fs::Permissions::from_mode(0o1700)).unwrap();
    assert!(matches!(
        JsonlJournal::open(&state),
        Err(JournalError::Unavailable { .. })
    ));

    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    initialize(&state);
    fs::set_permissions(journal_file(&state), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        JsonlJournalReader::open(&state),
        Err(JournalError::Unavailable { .. })
    ));

    fs::set_permissions(journal_file(&state), fs::Permissions::from_mode(0o4600)).unwrap();
    assert!(matches!(
        JsonlJournalReader::open(&state),
        Err(JournalError::Unavailable { .. })
    ));
}

#[test]
fn rejects_symlink_artifacts_without_reading_or_mutating_their_targets() {
    use std::os::unix::fs::symlink;

    for name in [LOCK_FILE_NAME, JOURNAL_FILE_NAME, COMMIT_FILE_NAME] {
        let dir = TempDir::new();
        let state = dir.state();
        initialize(&state);
        let target = dir.path().join(format!("{name}.target"));
        let protected = format!("protected bytes for {name}").into_bytes();
        create_private_file(&target, &protected);
        fs::remove_file(state.join(name)).unwrap();
        symlink(&target, state.join(name)).unwrap();

        let result = JsonlJournalReader::open(&state);
        assert!(
            matches!(result, Err(JournalError::Unavailable { .. })),
            "symlink {name} returned {result:?}"
        );
        assert_eq!(
            fs::read(&target).unwrap(),
            protected,
            "reader followed {name}"
        );
        assert!(matches!(
            JsonlJournal::open(&state),
            Err(JournalError::Unavailable { .. })
        ));
        assert_eq!(
            fs::read(&target).unwrap(),
            protected,
            "writer followed {name}"
        );
    }

    let dir = TempDir::new();
    let state = dir.state();
    safe_partial_initialization(&state);
    let target = dir.path().join("temp.target");
    let protected = b"temp target must remain intact";
    create_private_file(&target, protected);
    symlink(&target, state.join(COMMIT_TEMP_FILE_NAME)).unwrap();
    assert!(matches!(
        JsonlJournal::open(&state),
        Err(JournalError::Unavailable { .. })
    ));
    assert_eq!(fs::read(target).unwrap(), protected);
}

#[test]
fn rejects_special_file_artifacts_before_opening_them() {
    for name in [LOCK_FILE_NAME, JOURNAL_FILE_NAME, COMMIT_FILE_NAME] {
        let dir = TempDir::new();
        let state = dir.state();
        initialize(&state);
        fs::remove_file(state.join(name)).unwrap();
        create_private_fifo(&state.join(name));
        assert!(matches!(
            JsonlJournalReader::open(&state),
            Err(JournalError::Unavailable { .. })
        ));
        assert!(matches!(
            JsonlJournal::open(&state),
            Err(JournalError::Unavailable { .. })
        ));
    }

    let dir = TempDir::new();
    let state = dir.state();
    safe_partial_initialization(&state);
    create_private_fifo(&state.join(COMMIT_TEMP_FILE_NAME));
    assert!(matches!(
        JsonlJournal::open(&state),
        Err(JournalError::Unavailable { .. })
    ));
}

#[test]
fn rejects_hard_linked_artifacts_without_mutating_the_other_link() {
    for name in [LOCK_FILE_NAME, JOURNAL_FILE_NAME, COMMIT_FILE_NAME] {
        let dir = TempDir::new();
        let state = dir.state();
        initialize(&state);
        let target = dir.path().join(format!("{name}.target"));
        fs::rename(state.join(name), &target).unwrap();
        fs::hard_link(&target, state.join(name)).unwrap();
        let protected = fs::read(&target).unwrap();
        assert!(matches!(
            JsonlJournalReader::open(&state),
            Err(JournalError::Unavailable { .. })
        ));
        assert!(matches!(
            JsonlJournal::open(&state),
            Err(JournalError::Unavailable { .. })
        ));
        assert_eq!(fs::read(target).unwrap(), protected);
    }

    let dir = TempDir::new();
    let state = dir.state();
    safe_partial_initialization(&state);
    let target = dir.path().join("temp-hardlink.target");
    let protected = b"hard-linked temp target must remain intact";
    create_private_file(&target, protected);
    fs::hard_link(&target, state.join(COMMIT_TEMP_FILE_NAME)).unwrap();
    assert!(matches!(
        JsonlJournal::open(&state),
        Err(JournalError::Unavailable { .. })
    ));
    assert_eq!(fs::read(target).unwrap(), protected);
}

#[test]
fn complete_unpublished_tail_remains_unknown_and_is_never_promoted() {
    let dir = TempDir::new();
    let state = dir.state();
    let mut writer = JsonlJournal::open(&state).unwrap();
    writer.append(&event("evt-1"), signals::at(0)).unwrap();
    drop(writer);
    let committed = fs::read(commit_file(&state)).unwrap();

    let mut file = OpenOptions::new()
        .append(true)
        .open(journal_file(&state))
        .unwrap();
    writeln!(file, "{}", raw_line(2, "evt-tail")).unwrap();
    file.sync_all().unwrap();
    let tailed = fs::read(journal_file(&state)).unwrap();

    assert!(matches!(
        read_snapshot(&state),
        Err(JournalError::OutcomeUnknown { .. })
    ));
    let mut writer = JsonlJournal::open(&state).unwrap();
    assert!(matches!(
        writer.load_committed(),
        Err(JournalError::OutcomeUnknown { .. })
    ));
    assert!(matches!(
        writer.append(&event("evt-new"), signals::at(1)),
        Err(JournalError::OutcomeUnknown { .. })
    ));
    drop(writer);
    assert_eq!(fs::read(journal_file(&state)).unwrap(), tailed);
    assert_eq!(fs::read(commit_file(&state)).unwrap(), committed);
}

#[test]
fn digest_length_count_and_prefix_mismatches_fail_closed() {
    let dir = TempDir::new();
    let state = dir.state();
    let contents = format!("{}\n", raw_line(1, "evt-1"));
    replace_snapshot(&state, &contents, 1);

    let mut changed = contents.into_bytes();
    let position = changed.iter().position(|byte| *byte == b'1').unwrap();
    changed[position] = b'2';
    fs::write(journal_file(&state), changed).unwrap();
    assert!(matches!(
        read_snapshot(&state),
        Err(JournalError::Corrupt { .. })
    ));

    let dir = TempDir::new();
    let state = dir.state();
    let contents = format!("{}\n", raw_line(1, "evt-1"));
    replace_snapshot(&state, &contents, 2);
    assert!(matches!(
        read_snapshot(&state),
        Err(JournalError::Corrupt { .. })
    ));

    let dir = TempDir::new();
    let state = dir.state();
    replace_snapshot(&state, "", 0);
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(commit_file(&state)).unwrap()).unwrap();
    let mut metadata = metadata.as_object().unwrap().clone();
    metadata.insert("committedBytes".to_owned(), serde_json::json!(1));
    fs::write(commit_file(&state), serde_json::to_vec(&metadata).unwrap()).unwrap();
    assert!(matches!(
        read_snapshot(&state),
        Err(JournalError::Corrupt { .. })
    ));
}

#[test]
fn malformed_and_unsupported_commit_metadata_are_classified() {
    let dir = TempDir::new();
    let state = dir.state();
    initialize(&state);
    fs::write(commit_file(&state), b"not json").unwrap();
    assert!(matches!(
        read_snapshot(&state),
        Err(JournalError::Corrupt { .. })
    ));

    let dir = TempDir::new();
    let state = dir.state();
    replace_snapshot(&state, "", 0);
    let document = format!(
        r#"{{"storeVersion":2,"committedBytes":0,"committedEntries":0,"sha256":"{}"}}"#,
        digest_hex(b"")
    );
    fs::write(commit_file(&state), document).unwrap();
    assert_eq!(
        read_snapshot(&state).unwrap_err(),
        JournalError::SchemaUnsupported { found: 2 }
    );
}

#[test]
fn truncated_gapped_and_unsupported_records_are_not_reinterpreted() {
    let dir = TempDir::new();
    let state = dir.state();
    let truncated = format!("{}\n{}", raw_line(1, "evt-1"), &raw_line(2, "evt-2")[..40]);
    replace_snapshot(&state, &truncated, 2);
    assert!(matches!(
        read_snapshot(&state),
        Err(JournalError::Corrupt { .. })
    ));

    let dir = TempDir::new();
    let state = dir.state();
    let gap = format!("{}\n{}\n", raw_line(1, "evt-1"), raw_line(3, "evt-3"));
    replace_snapshot(&state, &gap, 2);
    let Err(JournalError::Corrupt { detail }) = read_snapshot(&state) else {
        panic!("gap must be corrupt")
    };
    assert!(detail.contains("seq 3 but 2 expected"), "{detail}");

    let dir = TempDir::new();
    let state = dir.state();
    let future = format!(
        "{}\n",
        raw_line(1, "evt-1").replacen(r#""schemaVersion":1"#, r#""schemaVersion":2"#, 1)
    );
    replace_snapshot(&state, &future, 1);
    assert_eq!(
        read_snapshot(&state).unwrap_err(),
        JournalError::SchemaUnsupported { found: 2 }
    );
}

#[test]
fn cold_reads_and_appends_are_bounded_without_touching_the_file() {
    let dir = TempDir::new();
    let state = dir.state();
    let mut contents = String::new();
    for seq in 1..=(MAX_JOURNAL_ENTRIES as u64 + 1) {
        contents.push_str(&raw_line(seq, &format!("evt-{seq}")));
        contents.push('\n');
    }
    replace_snapshot(&state, &contents, MAX_JOURNAL_ENTRIES as u64 + 1);
    assert_eq!(
        read_snapshot(&state).unwrap_err(),
        JournalError::BoundExceeded {
            max: MAX_JOURNAL_ENTRIES
        }
    );

    let dir = TempDir::new();
    let state = dir.state();
    contents.clear();
    for seq in 1..=MAX_JOURNAL_ENTRIES as u64 {
        contents.push_str(&raw_line(seq, &format!("evt-{seq}")));
        contents.push('\n');
    }
    replace_snapshot(&state, &contents, MAX_JOURNAL_ENTRIES as u64);
    let before_journal = fs::read(journal_file(&state)).unwrap();
    let before_commit = fs::read(commit_file(&state)).unwrap();
    let mut journal = JsonlJournal::open(&state).unwrap();
    assert_eq!(
        journal
            .append(&event("evt-over"), signals::at(0))
            .unwrap_err(),
        JournalError::BoundExceeded {
            max: MAX_JOURNAL_ENTRIES
        }
    );
    drop(journal);
    assert_eq!(fs::read(journal_file(&state)).unwrap(), before_journal);
    assert_eq!(fs::read(commit_file(&state)).unwrap(), before_commit);
    assert_eq!(read_snapshot(&state).unwrap().len(), MAX_JOURNAL_ENTRIES);
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
            })
        );
    }
}

#[test]
fn the_journal_file_still_holds_metadata_only() {
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
}
