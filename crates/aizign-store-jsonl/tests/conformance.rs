//! The journal record and store metadata decoders against every
//! language-neutral durable-format fixture.
//!
//! The fixtures are the same files the schema gate validates against
//! `spec/journal/v1/schemas/record.schema.json`, so schema and runtime
//! cannot drift apart unnoticed: a record this decoder accepts must be
//! schema-valid, and one it rejects must be schema-invalid unless the
//! expectation says the rule is outside what a JSON Schema can express.

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
use aizign_engine::JournalReader as _;
#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
use aizign_store_jsonl::{COMMIT_FILE_NAME, JsonlJournal, JsonlJournalReader};
use aizign_store_jsonl::{decode_record, encode_record};
#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
use aizign_testkit::TempDir;
use aizign_testkit::conformance::{self, Direction};

fn json(text: &str) -> serde_json::Value {
    serde_json::from_str(text).expect("record is JSON")
}

fn line(frame: &[u8]) -> String {
    String::from_utf8(frame.to_vec()).expect("record is UTF-8")
}

#[test]
fn valid_records_decode_and_round_trip() {
    for fixture in conformance::valid(Direction::Journal) {
        let entry = decode_record(&line(&fixture.frame))
            .unwrap_or_else(|error| panic!("{}: {error}", fixture.name));
        let encoded =
            encode_record(&entry).unwrap_or_else(|error| panic!("{}: {error}", fixture.name));
        assert_eq!(
            json(&encoded),
            json(&line(&fixture.frame)),
            "{}",
            fixture.name
        );
    }
}

#[test]
fn invalid_records_fail_with_the_expected_journal_code() {
    for fixture in conformance::invalid(Direction::Journal) {
        let error = decode_record(&line(&fixture.frame))
            .err()
            .unwrap_or_else(|| panic!("{}: must be rejected", fixture.name));
        assert_eq!(error.code(), fixture.code, "{}: code", fixture.name);
        assert_eq!(fixture.request_id, None, "{}", fixture.name);
        assert_eq!(fixture.kind, None, "{}", fixture.name);
    }
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn install_commit_fixture(frame: &[u8]) -> (TempDir, std::path::PathBuf) {
    let dir = TempDir::new();
    let state = dir.state();
    drop(JsonlJournal::open(&state).expect("initialize store"));
    std::fs::write(state.join(COMMIT_FILE_NAME), frame).expect("install commit fixture");
    (dir, state)
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
#[test]
fn valid_store_metadata_opens_an_empty_committed_snapshot() {
    for fixture in conformance::valid(Direction::Store) {
        let (_dir, state) = install_commit_fixture(&fixture.frame);
        let entries = JsonlJournalReader::open(&state)
            .and_then(|mut reader| reader.load_committed())
            .unwrap_or_else(|error| panic!("{}: {error}", fixture.name));
        assert!(entries.is_empty(), "{}", fixture.name);
    }
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
#[test]
fn invalid_store_metadata_fails_with_the_expected_journal_code() {
    for fixture in conformance::invalid(Direction::Store) {
        let (_dir, state) = install_commit_fixture(&fixture.frame);
        let error = JsonlJournalReader::open(&state)
            .and_then(|mut reader| reader.load_committed())
            .err()
            .unwrap_or_else(|| panic!("{}: must be rejected", fixture.name));
        assert_eq!(error.code(), fixture.code, "{}: code", fixture.name);
        assert_eq!(fixture.request_id, None, "{}", fixture.name);
        assert_eq!(fixture.kind, None, "{}", fixture.name);
    }
}
