//! Crate-internal executable evidence for every store-v2 semantic case.

#![cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]

use std::cell::Cell;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use aizign_core::workflow::WorkflowEvent;
use aizign_engine::{Journal, JournalError, JournalReader, MAX_JOURNAL_ENTRIES};
use aizign_testkit::{TempDir, signals};
use serde::Deserialize;

use crate::commit::{CommitPoint, MAX_COMMIT_METADATA_BYTES};
use crate::durability::{DurabilityOps, DurabilityPoint, ProductionDurability};
use crate::journal::{
    COMMIT_FILE_NAME, JOURNAL_FILE_NAME, JsonlJournal, JsonlJournalReader, LOCK_FILE_NAME,
    PUBLISH_FILE_NAME,
};
use crate::mountinfo::find_exact_mount;
use crate::profile::{ProfileObservation, ProfileOps, missing_statx_mount_id_for_test};
use crate::publish::PublishWitness;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    stage_or_cut_point: String,
    artifact_image: String,
    profile_observation: String,
    triggering_operation_code: Option<String>,
    later_reader_code: Option<String>,
    later_reader_disposition: String,
    writer_mutation_permitted: bool,
    unchanged_artifact_assertion: String,
    #[serde(skip)]
    triggering_consumed: Cell<bool>,
    #[serde(skip)]
    later_reader_consumed: Cell<bool>,
}

const CASES: &str = include_str!("../../../spec/store/v2/fixtures/cases.json");

#[test]
fn every_store_v2_case_executes_against_its_owner() {
    let cases: Vec<Case> = serde_json::from_str(CASES).expect("store-v2 case corpus");
    assert_eq!(cases.len(), 38, "authority contains exactly 38 cases");
    let mut executed = std::collections::BTreeSet::new();
    for case in &cases {
        assert!(executed.insert(case.id.as_str()), "duplicate case ID");
        case.validate_normative_row();
        execute(case);
        assert!(
            case.triggering_consumed.get(),
            "{} did not execute its triggering expectation",
            case.id
        );
        assert!(
            case.later_reader_consumed.get(),
            "{} did not execute its later-reader expectation",
            case.id
        );
    }
    assert_eq!(executed.len(), 38, "all authority rows executed once");
}

#[derive(Debug, PartialEq, Eq)]
struct ArtifactState {
    bytes: Vec<u8>,
    mode: u32,
    device: u64,
    inode: u64,
    links: u64,
}

fn artifact_snapshot(state: &Path) -> BTreeMap<&'static str, Option<ArtifactState>> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

    [
        LOCK_FILE_NAME,
        JOURNAL_FILE_NAME,
        COMMIT_FILE_NAME,
        PUBLISH_FILE_NAME,
        "workflow.commit.tmp",
    ]
    .into_iter()
    .map(|name| {
        let path = state.join(name);
        let value = fs::symlink_metadata(&path)
            .ok()
            .map(|metadata| ArtifactState {
                bytes: fs::read(&path).unwrap_or_default(),
                mode: metadata.permissions().mode(),
                device: metadata.dev(),
                inode: metadata.ino(),
                links: metadata.nlink(),
            });
        (name, value)
    })
    .collect()
}

impl Case {
    fn validate_normative_row(&self) {
        assert!(!self.stage_or_cut_point.is_empty(), "{} stage", self.id);
        assert!(!self.artifact_image.is_empty(), "{} image", self.id);
        assert!(!self.profile_observation.is_empty(), "{} profile", self.id);
        assert!(
            !self.unchanged_artifact_assertion.is_empty(),
            "{} artifact assertion",
            self.id
        );
        assert!(
            matches!(
                self.later_reader_disposition.as_str(),
                "known_absent"
                    | "known_from_exact_prefix"
                    | "unavailable"
                    | "corrupt"
                    | "schema_unsupported"
                    | "unknown"
            ),
            "{} disposition",
            self.id
        );
    }

    fn expect_trigger<T>(&self, state: &Path, operation: impl FnOnce() -> Result<T, JournalError>) {
        assert!(!self.triggering_consumed.replace(true), "duplicate trigger");
        let before = (!self.writer_mutation_permitted).then(|| artifact_snapshot(state));
        expect_code(operation(), self.triggering_operation_code.as_deref());
        if let Some(before) = before {
            assert_eq!(
                artifact_snapshot(state),
                before,
                "{} violated: {}",
                self.id,
                self.unchanged_artifact_assertion
            );
        }
    }

    fn expect_trigger_external_mutation<T>(
        &self,
        _state: &Path,
        operation: impl FnOnce() -> Result<T, JournalError>,
    ) {
        assert!(!self.triggering_consumed.replace(true), "duplicate trigger");
        expect_code(operation(), self.triggering_operation_code.as_deref());
    }

    fn expect_later(
        &self,
        state: &Path,
        operation: impl FnOnce() -> Result<Vec<aizign_engine::JournalEntry>, JournalError>,
    ) {
        assert!(
            !self.later_reader_consumed.replace(true),
            "duplicate reader"
        );
        let before = artifact_snapshot(state);
        let result = operation();
        match (&result, self.later_reader_disposition.as_str()) {
            (Ok(entries), "known_absent") => assert!(entries.is_empty(), "{} absent", self.id),
            (Ok(_), "known_from_exact_prefix") => {}
            (Err(error), "unavailable") => assert_eq!(error.code(), "JOURNAL_UNAVAILABLE"),
            (Err(error), "corrupt") => assert_eq!(error.code(), "JOURNAL_CORRUPT"),
            (Err(error), "schema_unsupported") => {
                assert_eq!(error.code(), "JOURNAL_SCHEMA_UNSUPPORTED");
            }
            (Err(error), "unknown") => assert_eq!(error.code(), "JOURNAL_OUTCOME_UNKNOWN"),
            _ => panic!(
                "{} later-reader disposition {} did not match result",
                self.id, self.later_reader_disposition
            ),
        }
        expect_code(result, self.later_reader_code.as_deref());
        assert_eq!(
            artifact_snapshot(state),
            before,
            "{} reader mutated store artifacts",
            self.id
        );
    }
}

fn execute(case: &Case) {
    match case.id.as_str() {
        "init-fresh-clean" => fresh_clean(case),
        "init-pre-marker-partial" => pre_marker_partial(case),
        "init-commit-marker-no-witness" => commit_without_witness(case),
        "init-prepared-rebarrier-success" => prepared_initialization_resumes(case),
        "init-prepared-file-sync-dir-sync-failure-same-boot" => prepared_rebarrier_failure(case),
        "init-prepared-rebarrier-inode-replaced" => prepared_identity_replacement(case),
        "init-clean-final-sync-failure-visible" => visible_clean_initialization_failure(case),
        "init-clean-missing-commit" => clean_missing_commit(case),
        "init-prepared-nonempty-journal" => prepared_nonempty_journal(case),
        "init-v1-commit" => unsupported_commit(case, 1),
        "init-unknown-version" => unsupported_commit(case, 99),
        "init-malformed-witness" => malformed_witness(case),
        "append-clean-generation" => clean_generation(case),
        "append-prepared-old-commit-old-journal" => prepared_image(case, Tail::None),
        "append-prepared-old-commit-partial-journal" => prepared_image(case, Tail::Partial),
        "append-prepared-old-commit-new-journal" => prepared_image(case, Tail::Complete),
        "append-prepared-new-commit-new-journal" => prepared_after_commit_rename(case),
        "append-clean-tail" => clean_tail(case),
        "append-clean-digest-mismatch" => digest_mismatch(case),
        "append-generation-gap" => contradictory_witness(case, 4, 1),
        "append-reverse-witness" => contradictory_witness(case, 1, 2),
        "append-bound-generation-10001" => maximum_generation(case),
        "append-visible-clean-final-sync-failure" => visible_clean_append_failure(case),
        "profile-ext4-rw-pass" => profile_pass(case),
        "profile-shared-magic-non-ext4-fail" => profile_failure(case, |value| {
            value.filesystem_type = "fuseblk".to_owned();
        }),
        "profile-mount-id-missing-fail" => missing_mount_id(case),
        "profile-mountinfo-ambiguous-fail" => ambiguous_mountinfo(case),
        "profile-per-mount-ro-fail" => profile_failure(case, |value| {
            value.mount_read_only = true;
        }),
        "profile-superblock-ro-fail" => profile_failure(case, |value| {
            value.superblock_read_only = true;
        }),
        "profile-parent-child-mount-mismatch-fail" => parent_child_profile_mismatch(case),
        "profile-artifact-device-mismatch-fail" => profile_identity_mismatch(case, |value| {
            value.device_minor += 1;
        }),
        "profile-artifact-identity-replacement-fail" => lock_identity_replacement(case),
        "profile-reader-unsupported-never-known" => unsupported_reader(case),
        "profile-statx-nosys-fail" => profile_observation_failure(case),
        "revalidate-journal-byte-mutation" => revalidation_mutation(case, Artifact::Journal),
        "revalidate-commit-mutation" => revalidation_mutation(case, Artifact::Commit),
        "revalidate-witness-mutation" => revalidation_mutation(case, Artifact::Witness),
        "revalidate-artifact-replacement" => revalidation_mutation(case, Artifact::Lock),
        other => panic!("store-v2 case has no executor: {other}"),
    }
}

fn event(id: &str) -> WorkflowEvent {
    WorkflowEvent::SignalAccepted {
        signal: signals::implementation_ready(id),
    }
}

fn valid_observation() -> ProfileObservation {
    ProfileObservation {
        mount_id: 17,
        device_major: 8,
        device_minor: 1,
        filesystem_type: "ext4".to_owned(),
        filesystem_magic: 0xef53,
        mount_read_only: false,
        superblock_read_only: false,
    }
}

struct FixedProfile(ProfileObservation);

impl Default for FixedProfile {
    fn default() -> Self {
        Self(valid_observation())
    }
}

impl ProfileOps for FixedProfile {
    fn observe(&mut self, _opened: &File) -> Result<ProfileObservation, JournalError> {
        Ok(self.0.clone())
    }
}

struct FailingProfile;

impl ProfileOps for FailingProfile {
    fn observe(&mut self, _opened: &File) -> Result<ProfileObservation, JournalError> {
        Err(JournalError::Unavailable {
            detail: "injected statx failure".to_owned(),
        })
    }
}

#[derive(Default)]
struct InjectedDurability {
    fail_before: Option<DurabilityPoint>,
    replace_before: Option<(DurabilityPoint, PathBuf, Vec<u8>)>,
    fail_untracked_directory_barrier: bool,
    replace_before_untracked_directory_barrier: Option<(PathBuf, Vec<u8>)>,
}

impl DurabilityOps for InjectedDurability {
    fn before(&mut self, point: DurabilityPoint) -> std::io::Result<()> {
        if self
            .replace_before
            .as_ref()
            .is_some_and(|(target, _, _)| *target == point)
        {
            let (_, path, bytes) = self.replace_before.take().expect("replacement");
            let replacement = path.with_extension("replacement");
            write_private(&replacement, &bytes);
            fs::rename(replacement, path)?;
        }
        if self.fail_before == Some(point) {
            return Err(std::io::Error::other("injected durability failure"));
        }
        Ok(())
    }

    fn barrier_directory_untracked(&mut self, directory: &File) -> std::io::Result<()> {
        if let Some((path, bytes)) = self.replace_before_untracked_directory_barrier.take() {
            let replacement = path.with_extension("replacement");
            write_private(&replacement, &bytes);
            fs::rename(replacement, path)?;
        }
        if self.fail_untracked_directory_barrier {
            return Err(std::io::Error::other("injected directory barrier failure"));
        }
        directory.sync_all()
    }
}

#[derive(Default)]
struct TracingDurability {
    points: Vec<DurabilityPoint>,
}

impl DurabilityOps for TracingDurability {
    fn before(&mut self, point: DurabilityPoint) -> std::io::Result<()> {
        self.points.push(point);
        Ok(())
    }
}

struct SequenceProfile {
    observations: std::collections::VecDeque<ProfileObservation>,
    last: ProfileObservation,
}

impl SequenceProfile {
    fn new(observations: impl IntoIterator<Item = ProfileObservation>) -> Self {
        let observations: std::collections::VecDeque<_> = observations.into_iter().collect();
        let last = observations
            .back()
            .expect("non-empty profile sequence")
            .clone();
        Self { observations, last }
    }
}

impl ProfileOps for SequenceProfile {
    fn observe(&mut self, _opened: &File) -> Result<ProfileObservation, JournalError> {
        Ok(self
            .observations
            .pop_front()
            .unwrap_or_else(|| self.last.clone()))
    }
}

struct AmbiguousMountProfile;

impl ProfileOps for AmbiguousMountProfile {
    fn observe(&mut self, _opened: &File) -> Result<ProfileObservation, JournalError> {
        let row = "36 25 8:1 / / rw - ext4 /dev/root rw\n";
        let _ = find_exact_mount(&format!("{row}{row}"), 36)?;
        unreachable!("an ambiguous mount ID must fail closed")
    }
}

fn state() -> (TempDir, PathBuf) {
    let temporary = TempDir::new();
    let state = temporary.state();
    (temporary, state)
}

fn open_fake(state: &Path) -> Result<JsonlJournal, JournalError> {
    JsonlJournal::open_with_ops(
        state,
        &mut ProductionDurability,
        &mut FixedProfile::default(),
    )
}

fn open_production(state: &Path) -> Result<JsonlJournal, JournalError> {
    JsonlJournal::open(state)
}

fn read_with_profile(
    state: &Path,
    profile: &mut dyn ProfileOps,
) -> Result<Vec<aizign_engine::JournalEntry>, JournalError> {
    let mut reader = JsonlJournalReader::open_with_profile(state, profile)?;
    reader.load_committed_with_profile(profile)
}

fn read_production(state: &Path) -> Result<Vec<aizign_engine::JournalEntry>, JournalError> {
    let mut reader = JsonlJournalReader::open(state)?;
    reader.load_committed()
}

fn append_fake(
    journal: &mut JsonlJournal,
    id: &str,
    durability: &mut dyn DurabilityOps,
) -> Result<aizign_engine::JournalEntry, JournalError> {
    journal.append_with_ops(
        &event(id),
        signals::at(0),
        durability,
        &mut FixedProfile::default(),
        None,
    )
}

fn append_production(
    journal: &mut JsonlJournal,
    id: &str,
) -> Result<aizign_engine::JournalEntry, JournalError> {
    journal.append(&event(id), signals::at(0))
}

fn expect_code(result: Result<impl Sized, JournalError>, expected: Option<&str>) {
    match (result, expected) {
        (Ok(_), None) => {}
        (Err(error), Some(code)) => assert_eq!(error.code(), code),
        (Ok(_), Some(code)) => panic!("expected {code}, got success"),
        (Err(error), None) => panic!("unexpected {}", error.code()),
    }
}

fn write_private(path: &Path, bytes: &[u8]) {
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(bytes).unwrap();
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .unwrap();
}

fn write_witness(state: &Path, witness: PublishWitness) {
    write_private(&state.join(PUBLISH_FILE_NAME), &witness.encode());
}

fn fresh_clean(case: &Case) {
    let (_temporary, state) = state();
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));
    assert_eq!(
        fs::read(state.join(COMMIT_FILE_NAME)).unwrap(),
        CommitPoint::empty().encode()
    );
    assert_eq!(
        fs::read(state.join(PUBLISH_FILE_NAME)).unwrap(),
        PublishWitness::clean(1).encode()
    );
}

fn pre_marker_partial(case: &Case) {
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};

    let (_temporary, state) = state();
    fs::DirBuilder::new().mode(0o700).create(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    write_private(&state.join(LOCK_FILE_NAME), b"");
    let before = fs::read_dir(&state).unwrap().count();
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));
    assert_eq!(fs::read_dir(&state).unwrap().count(), before);
}

fn commit_without_witness(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    fs::remove_file(state.join(PUBLISH_FILE_NAME)).unwrap();
    case.expect_trigger(&state, || read_production(&state));
    case.expect_later(&state, || read_production(&state));
    open_production(&state).expect("exclusive writer completes exact generation-1 witness");
    assert_eq!(
        PublishWitness::decode(&fs::read(state.join(PUBLISH_FILE_NAME)).unwrap()).unwrap(),
        PublishWitness::clean(1)
    );
}

fn prepared_initialization_resumes(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    let commit = fs::read(state.join(COMMIT_FILE_NAME)).unwrap();
    write_witness(&state, PublishWitness::initializing());
    case.expect_trigger(&state, || open_production(&state));
    assert_eq!(fs::read(state.join(COMMIT_FILE_NAME)).unwrap(), commit);
    case.expect_later(&state, || read_production(&state));
}

fn prepared_rebarrier_failure(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    write_witness(&state, PublishWitness::initializing());
    let mut durability = InjectedDurability {
        fail_untracked_directory_barrier: true,
        ..InjectedDurability::default()
    };
    case.expect_trigger(&state, || {
        JsonlJournal::open_with_ops(&state, &mut durability, &mut FixedProfile::default())
    });
    assert_eq!(
        PublishWitness::decode(&fs::read(state.join(PUBLISH_FILE_NAME)).unwrap()).unwrap(),
        PublishWitness::initializing()
    );
    case.expect_later(&state, || read_production(&state));
}

fn prepared_identity_replacement(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    write_witness(&state, PublishWitness::initializing());
    let commit_before = fs::read(state.join(COMMIT_FILE_NAME)).unwrap();
    let journal_before = fs::read(state.join(JOURNAL_FILE_NAME)).unwrap();
    let mut durability = InjectedDurability {
        replace_before_untracked_directory_barrier: Some((
            state.join(PUBLISH_FILE_NAME),
            PublishWitness::initializing().encode(),
        )),
        ..InjectedDurability::default()
    };
    case.expect_trigger_external_mutation(&state, || {
        JsonlJournal::open_with_ops(&state, &mut durability, &mut FixedProfile::default())
    });
    assert_eq!(
        fs::read(state.join(PUBLISH_FILE_NAME)).unwrap(),
        PublishWitness::initializing().encode()
    );
    assert_eq!(
        fs::read(state.join(COMMIT_FILE_NAME)).unwrap(),
        commit_before
    );
    assert_eq!(
        fs::read(state.join(JOURNAL_FILE_NAME)).unwrap(),
        journal_before
    );
    case.expect_later(&state, || read_production(&state));
}

fn visible_clean_initialization_failure(case: &Case) {
    let (_temporary, state) = state();
    let mut durability = InjectedDurability {
        fail_before: Some(DurabilityPoint::CleanBarrierComplete),
        ..InjectedDurability::default()
    };
    case.expect_trigger_external_mutation(&state, || {
        JsonlJournal::open_with_ops(&state, &mut durability, &mut FixedProfile::default())
    });
    assert_eq!(
        fs::read(state.join(PUBLISH_FILE_NAME)).unwrap(),
        PublishWitness::clean(1).encode()
    );
    case.expect_later(&state, || read_production(&state));
}

fn clean_missing_commit(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    fs::remove_file(state.join(COMMIT_FILE_NAME)).unwrap();
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));
}

fn prepared_nonempty_journal(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    write_private(&state.join(JOURNAL_FILE_NAME), b"partial");
    write_witness(&state, PublishWitness::initializing());
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));
}

fn unsupported_commit(case: &Case, version: u64) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    write_private(
        &state.join(COMMIT_FILE_NAME),
        format!(
            "{{\"storeVersion\":{version},\"generation\":1,\"committedBytes\":0,\"committedEntries\":0,\"sha256\":\"{}\"}}",
            "0".repeat(64)
        )
        .as_bytes(),
    );
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));
}

fn malformed_witness(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    write_private(&state.join(PUBLISH_FILE_NAME), b"{}");
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));
}

fn clean_generation(case: &Case) {
    let (_temporary, state) = state();
    let mut journal = open_production(&state).unwrap();
    case.expect_trigger(&state, || append_production(&mut journal, "evt-clean"));
    drop(journal);
    case.expect_later(&state, || read_production(&state));
}

#[derive(Clone, Copy)]
enum Tail {
    None,
    Partial,
    Complete,
}

fn prepared_image(case: &Case, tail: Tail) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    if matches!(tail, Tail::Partial | Tail::Complete) {
        let bytes: &[u8] = if matches!(tail, Tail::Partial) {
            b"{\"partial\""
        } else {
            b"{}\n"
        };
        fs::OpenOptions::new()
            .append(true)
            .open(state.join(JOURNAL_FILE_NAME))
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }
    write_witness(&state, PublishWitness::prepared(2));
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));
}

fn prepared_after_commit_rename(case: &Case) {
    let (_temporary, state) = state();
    let mut journal = open_production(&state).unwrap();
    let mut durability = InjectedDurability {
        fail_before: Some(DurabilityPoint::CommitDirectoryBarrierComplete),
        ..InjectedDurability::default()
    };
    case.expect_trigger_external_mutation(&state, || {
        append_fake(&mut journal, "evt-renamed", &mut durability)
    });
    drop(journal);
    assert_eq!(
        PublishWitness::decode(&fs::read(state.join(PUBLISH_FILE_NAME)).unwrap()).unwrap(),
        PublishWitness::prepared(2)
    );
    case.expect_later(&state, || read_production(&state));
}

fn clean_tail(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    fs::OpenOptions::new()
        .append(true)
        .open(state.join(JOURNAL_FILE_NAME))
        .unwrap()
        .write_all(b"tail")
        .unwrap();
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));
}

fn digest_mismatch(case: &Case) {
    let (_temporary, state) = state();
    let mut journal = open_production(&state).unwrap();
    append_production(&mut journal, "evt-digest").unwrap();
    drop(journal);
    let path = state.join(JOURNAL_FILE_NAME);
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] ^= 1;
    write_private(&path, &bytes);
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));
}

fn contradictory_witness(case: &Case, started: u64, published: u64) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    let document = format!(
        "{{\"storeVersion\":2,\"startedGeneration\":{started},\"publishedGeneration\":{published}}}"
    );
    write_private(&state.join(PUBLISH_FILE_NAME), document.as_bytes());
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));

    if case.id == "append-generation-gap" {
        let (_temporary_gap, gap_state) = crate::store_v2_cases::state();
        let mut journal = open_production(&gap_state).unwrap();
        append_production(&mut journal, "evt-gap-1").unwrap();
        append_production(&mut journal, "evt-gap-2").unwrap();
        drop(journal);
        write_witness(&gap_state, PublishWitness::prepared(2));
        expect_code(
            open_production(&gap_state),
            case.triggering_operation_code.as_deref(),
        );
        expect_code(
            read_production(&gap_state),
            case.later_reader_code.as_deref(),
        );
    }
}

fn maximum_generation(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    let template = event("evt-bound");
    let mut journal_bytes = Vec::new();
    for seq in 1..=MAX_JOURNAL_ENTRIES as u64 {
        let entry = aizign_engine::JournalEntry {
            seq,
            at: signals::at(0),
            event: template.clone(),
        };
        journal_bytes.extend_from_slice(crate::record::encode_entry(&entry).unwrap().as_bytes());
        journal_bytes.push(b'\n');
    }
    let point = CommitPoint::for_prefix(&journal_bytes, MAX_JOURNAL_ENTRIES as u64);
    write_private(&state.join(JOURNAL_FILE_NAME), &journal_bytes);
    write_private(&state.join(COMMIT_FILE_NAME), &point.encode());
    write_witness(
        &state,
        PublishWitness::clean(MAX_JOURNAL_ENTRIES as u64 + 1),
    );
    let before = [
        fs::read(state.join(JOURNAL_FILE_NAME)).unwrap(),
        fs::read(state.join(COMMIT_FILE_NAME)).unwrap(),
        fs::read(state.join(PUBLISH_FILE_NAME)).unwrap(),
    ];
    let mut journal = open_production(&state).unwrap();
    case.expect_trigger(&state, || append_production(&mut journal, "evt-over-bound"));
    drop(journal);
    case.expect_later(&state, || read_production(&state));
    assert_eq!(
        before,
        [
            fs::read(state.join(JOURNAL_FILE_NAME)).unwrap(),
            fs::read(state.join(COMMIT_FILE_NAME)).unwrap(),
            fs::read(state.join(PUBLISH_FILE_NAME)).unwrap(),
        ]
    );
}

fn visible_clean_append_failure(case: &Case) {
    let (_temporary, state) = state();
    let mut journal = open_production(&state).unwrap();
    let mut durability = InjectedDurability {
        fail_before: Some(DurabilityPoint::CleanBarrierComplete),
        ..InjectedDurability::default()
    };
    case.expect_trigger_external_mutation(&state, || {
        append_fake(&mut journal, "evt-visible", &mut durability)
    });
    drop(journal);
    assert_eq!(
        PublishWitness::decode(&fs::read(state.join(PUBLISH_FILE_NAME)).unwrap()).unwrap(),
        PublishWitness::clean(2)
    );
    case.expect_later(&state, || read_production(&state));
}

fn profile_pass(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    case.expect_trigger(&state, || open_production(&state));
    case.expect_later(&state, || read_production(&state));
}

fn profile_failure(case: &Case, mutate: impl FnOnce(&mut ProfileObservation)) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    let mut observation = valid_observation();
    mutate(&mut observation);
    let mut writer_profile = FixedProfile(observation.clone());
    case.expect_trigger(&state, || {
        JsonlJournal::open_with_ops(&state, &mut ProductionDurability, &mut writer_profile)
    });
    let mut reader_profile = FixedProfile(observation);
    case.expect_later(&state, || read_with_profile(&state, &mut reader_profile));
}

fn missing_mount_id(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    case.expect_trigger(&state, missing_statx_mount_id_for_test);
    case.expect_later(&state, || {
        missing_statx_mount_id_for_test()?;
        unreachable!("missing mount ID must fail before a reader becomes known")
    });
}

fn ambiguous_mountinfo(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    case.expect_trigger(&state, || {
        JsonlJournal::open_with_ops(
            &state,
            &mut ProductionDurability,
            &mut AmbiguousMountProfile,
        )
    });
    case.expect_later(&state, || {
        read_with_profile(&state, &mut AmbiguousMountProfile)
    });
}

fn parent_child_profile_mismatch(case: &Case) {
    let (_temporary, state) = state();
    let mut child = valid_observation();
    child.mount_id += 1;
    let mut profile = SequenceProfile::new([valid_observation(), child.clone(), child]);
    case.expect_trigger(&state, || {
        JsonlJournal::open_with_ops(&state, &mut ProductionDurability, &mut profile)
    });
    assert!(state.is_dir());
    assert_eq!(fs::read_dir(&state).unwrap().count(), 0);
    case.expect_later(&state, || read_production(&state));
}

fn profile_identity_mismatch(case: &Case, mutate: impl FnOnce(&mut ProfileObservation)) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    let mut actual = valid_observation();
    mutate(&mut actual);
    let mut writer_profile = SequenceProfile::new([valid_observation(), actual.clone()]);
    case.expect_trigger(&state, || {
        JsonlJournal::open_with_ops(&state, &mut ProductionDurability, &mut writer_profile)
    });
    let mut reader_profile = SequenceProfile::new([valid_observation(), actual]);
    case.expect_later(&state, || read_with_profile(&state, &mut reader_profile));
}

fn lock_identity_replacement(case: &Case) {
    use std::os::unix::fs::PermissionsExt as _;

    let (_temporary, state) = state();
    let mut journal = open_production(&state).unwrap();
    fs::remove_file(state.join(LOCK_FILE_NAME)).unwrap();
    write_private(&state.join(LOCK_FILE_NAME), b"");
    let before = artifact_snapshot(&state);
    case.expect_trigger_external_mutation(&state, || {
        append_production(&mut journal, "evt-lock-replaced")
    });
    assert_eq!(artifact_snapshot(&state), before);
    fs::set_permissions(
        state.join(LOCK_FILE_NAME),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    drop(journal);
    case.expect_later(&state, || read_production(&state));
}

fn unsupported_reader(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    let mut unsupported = valid_observation();
    unsupported.filesystem_type = "tmpfs".to_owned();
    case.expect_trigger(&state, || {
        JsonlJournal::open_with_ops(
            &state,
            &mut ProductionDurability,
            &mut FixedProfile(unsupported.clone()),
        )
    });
    case.expect_later(&state, || {
        read_with_profile(&state, &mut FixedProfile(unsupported))
    });
}

fn profile_observation_failure(case: &Case) {
    let (_temporary, state) = state();
    drop(open_production(&state).unwrap());
    case.expect_trigger(&state, || {
        JsonlJournal::open_with_ops(&state, &mut ProductionDurability, &mut FailingProfile)
    });
    case.expect_later(&state, || read_with_profile(&state, &mut FailingProfile));
}

#[derive(Clone, Copy)]
enum Artifact {
    Journal,
    Commit,
    Witness,
    Lock,
}

fn revalidation_mutation(case: &Case, artifact: Artifact) {
    let (_temporary, state) = state();
    let mut journal = open_production(&state).unwrap();
    append_production(&mut journal, "evt-before-mutation").unwrap();
    match artifact {
        Artifact::Journal => {
            let path = state.join(JOURNAL_FILE_NAME);
            let mut bytes = fs::read(&path).unwrap();
            bytes[0] ^= 1;
            write_private(&path, &bytes);
        }
        Artifact::Commit => write_private(&state.join(COMMIT_FILE_NAME), b"{}"),
        Artifact::Witness => write_private(&state.join(PUBLISH_FILE_NAME), b"{}"),
        Artifact::Lock => {
            use std::os::unix::fs::PermissionsExt as _;

            fs::remove_file(state.join(LOCK_FILE_NAME)).unwrap();
            write_private(&state.join(LOCK_FILE_NAME), b"");
            fs::set_permissions(
                state.join(LOCK_FILE_NAME),
                fs::Permissions::from_mode(0o640),
            )
            .unwrap();
        }
    }
    case.expect_trigger(&state, || append_production(&mut journal, "evt-revalidate"));
    drop(journal);
    case.expect_later(&state, || read_production(&state));
}

#[test]
fn initialization_and_append_use_the_exact_durability_order() {
    let (_temporary, state) = state();
    let mut durability = TracingDurability::default();
    let mut journal =
        JsonlJournal::open_with_ops(&state, &mut durability, &mut FixedProfile::default()).unwrap();
    assert_eq!(
        durability.points,
        [
            DurabilityPoint::CommitTemporaryWriteComplete,
            DurabilityPoint::CommitTemporaryBarrierComplete,
            DurabilityPoint::CommitRenameComplete,
            DurabilityPoint::CommitDirectoryBarrierComplete,
            DurabilityPoint::PreparedWriteComplete,
            DurabilityPoint::PreparedBarrierComplete,
            DurabilityPoint::CleanWriteComplete,
            DurabilityPoint::CleanBarrierComplete,
        ]
    );

    durability.points.clear();
    append_fake(&mut journal, "evt-order", &mut durability).unwrap();
    assert_eq!(
        durability.points,
        [
            DurabilityPoint::PreparedWriteComplete,
            DurabilityPoint::PreparedBarrierComplete,
            DurabilityPoint::JournalRecordWriteComplete,
            DurabilityPoint::JournalBarrierComplete,
            DurabilityPoint::CommitTemporaryWriteComplete,
            DurabilityPoint::CommitTemporaryBarrierComplete,
            DurabilityPoint::CommitRenameComplete,
            DurabilityPoint::CommitDirectoryBarrierComplete,
            DurabilityPoint::CleanWriteComplete,
            DurabilityPoint::CleanBarrierComplete,
            DurabilityPoint::DurableAppendComplete,
        ]
    );
}

#[test]
fn every_append_prerequisite_failure_forbids_clean() {
    for point in [
        DurabilityPoint::PreparedBarrierComplete,
        DurabilityPoint::JournalBarrierComplete,
        DurabilityPoint::CommitTemporaryBarrierComplete,
        DurabilityPoint::CommitDirectoryBarrierComplete,
    ] {
        let (_temporary, state) = state();
        let mut journal = open_fake(&state).unwrap();
        let mut durability = InjectedDurability {
            fail_before: Some(point),
            ..InjectedDurability::default()
        };
        assert!(matches!(
            append_fake(&mut journal, "evt-prerequisite", &mut durability),
            Err(JournalError::OutcomeUnknown { .. })
        ));
        let witness = PublishWitness::decode(&fs::read(state.join(PUBLISH_FILE_NAME)).unwrap())
            .expect("visible witness remains structurally valid");
        assert_eq!(witness, PublishWitness::prepared(2), "failed at {point:?}");
    }
}

#[test]
fn metadata_bound_is_the_document_bound_used_by_the_owner() {
    assert_eq!(MAX_COMMIT_METADATA_BYTES, 4 * 1024);
}
