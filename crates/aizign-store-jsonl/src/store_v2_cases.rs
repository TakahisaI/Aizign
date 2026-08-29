//! Crate-internal executable evidence for every store-v2 semantic case.

#![cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]

use std::fs::{self, File};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use aizign_core::workflow::WorkflowEvent;
use aizign_engine::{JournalError, MAX_JOURNAL_ENTRIES};
use aizign_testkit::{TempDir, signals};
use serde::Deserialize;

use crate::commit::{CommitPoint, MAX_COMMIT_METADATA_BYTES};
use crate::durability::{DurabilityOps, DurabilityPoint, ProductionDurability};
use crate::journal::{
    COMMIT_FILE_NAME, JOURNAL_FILE_NAME, JsonlJournal, JsonlJournalReader, LOCK_FILE_NAME,
    PUBLISH_FILE_NAME,
};
use crate::mountinfo::find_exact_mount;
use crate::profile::{ProfileObservation, ProfileOps};
use crate::publish::PublishWitness;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    triggering_operation_code: Option<String>,
    later_reader_code: Option<String>,
}

const CASES: &str = include_str!("../../../spec/store/v2/fixtures/cases.json");

#[test]
fn every_store_v2_case_executes_against_its_owner() {
    let cases: Vec<Case> = serde_json::from_str(CASES).expect("store-v2 case corpus");
    assert_eq!(cases.len(), 38, "authority contains exactly 38 cases");
    let mut executed = std::collections::BTreeSet::new();
    for case in &cases {
        assert!(executed.insert(case.id.as_str()), "duplicate case ID");
        execute(case);
    }
    assert_eq!(executed.len(), 38, "all authority rows executed once");
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
        "profile-mount-id-missing-fail" => profile_failure(case, |value| value.mount_id = 0),
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

fn read_fake(state: &Path) -> Result<Vec<aizign_engine::JournalEntry>, JournalError> {
    let mut profile = FixedProfile::default();
    let mut reader = JsonlJournalReader::open_with_profile(state, &mut profile)?;
    reader.load_committed_with_profile(&mut profile)
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
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
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
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
    assert_eq!(fs::read_dir(&state).unwrap().count(), before);
}

fn commit_without_witness(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    fs::remove_file(state.join(PUBLISH_FILE_NAME)).unwrap();
    expect_code(read_fake(&state), case.triggering_operation_code.as_deref());
    open_fake(&state).expect("exclusive writer completes exact generation-1 witness");
    assert_eq!(
        PublishWitness::decode(&fs::read(state.join(PUBLISH_FILE_NAME)).unwrap()).unwrap(),
        PublishWitness::clean(1)
    );
}

fn prepared_initialization_resumes(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    let commit = fs::read(state.join(COMMIT_FILE_NAME)).unwrap();
    write_witness(&state, PublishWitness::initializing());
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    assert_eq!(fs::read(state.join(COMMIT_FILE_NAME)).unwrap(), commit);
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn prepared_rebarrier_failure(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    write_witness(&state, PublishWitness::initializing());
    let mut durability = InjectedDurability {
        fail_before: Some(DurabilityPoint::WitnessDirectoryBarrierComplete),
        ..InjectedDurability::default()
    };
    expect_code(
        JsonlJournal::open_with_ops(&state, &mut durability, &mut FixedProfile::default()),
        case.triggering_operation_code.as_deref(),
    );
    assert_eq!(
        PublishWitness::decode(&fs::read(state.join(PUBLISH_FILE_NAME)).unwrap()).unwrap(),
        PublishWitness::initializing()
    );
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn prepared_identity_replacement(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    write_witness(&state, PublishWitness::initializing());
    let mut durability = InjectedDurability {
        replace_before: Some((
            DurabilityPoint::WitnessDirectoryBarrierComplete,
            state.join(PUBLISH_FILE_NAME),
            PublishWitness::initializing().encode(),
        )),
        ..InjectedDurability::default()
    };
    expect_code(
        JsonlJournal::open_with_ops(&state, &mut durability, &mut FixedProfile::default()),
        case.triggering_operation_code.as_deref(),
    );
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn visible_clean_initialization_failure(case: &Case) {
    let (_temporary, state) = state();
    let mut durability = InjectedDurability {
        fail_before: Some(DurabilityPoint::CleanBarrierComplete),
        ..InjectedDurability::default()
    };
    expect_code(
        JsonlJournal::open_with_ops(&state, &mut durability, &mut FixedProfile::default()),
        case.triggering_operation_code.as_deref(),
    );
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn clean_missing_commit(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    fs::remove_file(state.join(COMMIT_FILE_NAME)).unwrap();
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn prepared_nonempty_journal(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    write_private(&state.join(JOURNAL_FILE_NAME), b"partial");
    write_witness(&state, PublishWitness::initializing());
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn unsupported_commit(case: &Case, version: u64) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    write_private(
        &state.join(COMMIT_FILE_NAME),
        format!(
            "{{\"storeVersion\":{version},\"generation\":1,\"committedBytes\":0,\"committedEntries\":0,\"sha256\":\"{}\"}}",
            "0".repeat(64)
        )
        .as_bytes(),
    );
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn malformed_witness(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    write_private(&state.join(PUBLISH_FILE_NAME), b"{}");
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn clean_generation(case: &Case) {
    let (_temporary, state) = state();
    let mut journal = open_fake(&state).unwrap();
    expect_code(
        append_fake(&mut journal, "evt-clean", &mut ProductionDurability),
        case.triggering_operation_code.as_deref(),
    );
    drop(journal);
    assert_eq!(read_fake(&state).unwrap().len(), 1);
}

#[derive(Clone, Copy)]
enum Tail {
    None,
    Partial,
    Complete,
}

fn prepared_image(case: &Case, tail: Tail) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
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
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn prepared_after_commit_rename(case: &Case) {
    let (_temporary, state) = state();
    let mut journal = open_fake(&state).unwrap();
    let mut durability = InjectedDurability {
        fail_before: Some(DurabilityPoint::CommitDirectoryBarrierComplete),
        ..InjectedDurability::default()
    };
    expect_code(
        append_fake(&mut journal, "evt-renamed", &mut durability),
        case.triggering_operation_code.as_deref(),
    );
    drop(journal);
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn clean_tail(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    fs::OpenOptions::new()
        .append(true)
        .open(state.join(JOURNAL_FILE_NAME))
        .unwrap()
        .write_all(b"tail")
        .unwrap();
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn digest_mismatch(case: &Case) {
    let (_temporary, state) = state();
    let mut journal = open_fake(&state).unwrap();
    append_fake(&mut journal, "evt-digest", &mut ProductionDurability).unwrap();
    drop(journal);
    let path = state.join(JOURNAL_FILE_NAME);
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] ^= 1;
    write_private(&path, &bytes);
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn contradictory_witness(case: &Case, started: u64, published: u64) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    let document = format!(
        "{{\"storeVersion\":2,\"startedGeneration\":{started},\"publishedGeneration\":{published}}}"
    );
    write_private(&state.join(PUBLISH_FILE_NAME), document.as_bytes());
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn maximum_generation(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
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
    let mut journal = open_fake(&state).unwrap();
    expect_code(
        append_fake(&mut journal, "evt-over-bound", &mut ProductionDurability),
        case.triggering_operation_code.as_deref(),
    );
    drop(journal);
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
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
    let mut journal = open_fake(&state).unwrap();
    let mut durability = InjectedDurability {
        fail_before: Some(DurabilityPoint::CleanBarrierComplete),
        ..InjectedDurability::default()
    };
    expect_code(
        append_fake(&mut journal, "evt-visible", &mut durability),
        case.triggering_operation_code.as_deref(),
    );
    drop(journal);
    assert_eq!(read_fake(&state).unwrap().len(), 1);
}

fn profile_pass(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    expect_code(open_fake(&state), case.triggering_operation_code.as_deref());
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn profile_failure(case: &Case, mutate: impl FnOnce(&mut ProfileObservation)) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    let mut observation = valid_observation();
    mutate(&mut observation);
    let mut writer_profile = FixedProfile(observation.clone());
    expect_code(
        JsonlJournal::open_with_ops(&state, &mut ProductionDurability, &mut writer_profile),
        case.triggering_operation_code.as_deref(),
    );
    let mut reader_profile = FixedProfile(observation);
    expect_code(
        JsonlJournalReader::open_with_profile(&state, &mut reader_profile),
        case.later_reader_code.as_deref(),
    );
}

fn ambiguous_mountinfo(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    expect_code(
        JsonlJournal::open_with_ops(
            &state,
            &mut ProductionDurability,
            &mut AmbiguousMountProfile,
        ),
        case.triggering_operation_code.as_deref(),
    );
    expect_code(
        JsonlJournalReader::open_with_profile(&state, &mut AmbiguousMountProfile),
        case.later_reader_code.as_deref(),
    );
}

fn parent_child_profile_mismatch(case: &Case) {
    let (_temporary, state) = state();
    let mut child = valid_observation();
    child.mount_id += 1;
    let mut profile = SequenceProfile::new([valid_observation(), child.clone(), child]);
    expect_code(
        JsonlJournal::open_with_ops(&state, &mut ProductionDurability, &mut profile),
        case.triggering_operation_code.as_deref(),
    );
    assert!(state.is_dir());
    assert_eq!(fs::read_dir(&state).unwrap().count(), 0);
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
}

fn profile_identity_mismatch(case: &Case, mutate: impl FnOnce(&mut ProfileObservation)) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    let mut actual = valid_observation();
    mutate(&mut actual);
    let mut writer_profile = SequenceProfile::new([valid_observation(), actual.clone()]);
    expect_code(
        JsonlJournal::open_with_ops(&state, &mut ProductionDurability, &mut writer_profile),
        case.triggering_operation_code.as_deref(),
    );
    let mut reader_profile = SequenceProfile::new([valid_observation(), actual]);
    expect_code(
        JsonlJournalReader::open_with_profile(&state, &mut reader_profile),
        case.later_reader_code.as_deref(),
    );
}

fn lock_identity_replacement(case: &Case) {
    let (_temporary, state) = state();
    let mut journal = open_fake(&state).unwrap();
    fs::remove_file(state.join(LOCK_FILE_NAME)).unwrap();
    write_private(&state.join(LOCK_FILE_NAME), b"");
    expect_code(
        append_fake(&mut journal, "evt-lock-replaced", &mut ProductionDurability),
        case.triggering_operation_code.as_deref(),
    );
}

fn unsupported_reader(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    let mut unsupported = valid_observation();
    unsupported.filesystem_type = "tmpfs".to_owned();
    expect_code(
        JsonlJournal::open_with_ops(
            &state,
            &mut ProductionDurability,
            &mut FixedProfile(unsupported.clone()),
        ),
        case.triggering_operation_code.as_deref(),
    );
    expect_code(
        JsonlJournalReader::open_with_profile(&state, &mut FixedProfile(unsupported)),
        case.later_reader_code.as_deref(),
    );
}

fn profile_observation_failure(case: &Case) {
    let (_temporary, state) = state();
    drop(open_fake(&state).unwrap());
    expect_code(
        JsonlJournal::open_with_ops(&state, &mut ProductionDurability, &mut FailingProfile),
        case.triggering_operation_code.as_deref(),
    );
    expect_code(
        JsonlJournalReader::open_with_profile(&state, &mut FailingProfile),
        case.later_reader_code.as_deref(),
    );
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
    let mut journal = open_fake(&state).unwrap();
    append_fake(
        &mut journal,
        "evt-before-mutation",
        &mut ProductionDurability,
    )
    .unwrap();
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
    let result = append_fake(&mut journal, "evt-revalidate", &mut ProductionDurability);
    expect_code(result, case.triggering_operation_code.as_deref());
    drop(journal);
    expect_code(read_fake(&state), case.later_reader_code.as_deref());
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
            DurabilityPoint::StateDirectoryCreate,
            DurabilityPoint::StateDirectoryBarrier,
            DurabilityPoint::ParentDirectoryBarrier,
            DurabilityPoint::LockFileCreate,
            DurabilityPoint::JournalFileCreate,
            DurabilityPoint::LockFileBarrier,
            DurabilityPoint::JournalFileBarrier,
            DurabilityPoint::ArtifactDirectoryBarrier,
            DurabilityPoint::CommitTemporaryCreate,
            DurabilityPoint::CommitTemporaryWriteComplete,
            DurabilityPoint::CommitTemporaryBarrierComplete,
            DurabilityPoint::CommitRenameComplete,
            DurabilityPoint::CommitDirectoryBarrierComplete,
            DurabilityPoint::WitnessCreate,
            DurabilityPoint::PreparedWriteComplete,
            DurabilityPoint::PreparedBarrierComplete,
            DurabilityPoint::WitnessDirectoryBarrierComplete,
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
            DurabilityPoint::CommitTemporaryCreate,
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
