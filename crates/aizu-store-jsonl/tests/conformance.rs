//! The journal record decoder against every language-neutral fixture in
//! `spec/conformance/{valid,invalid}/journal`.
//!
//! The fixtures are the same files the schema gate validates against
//! `spec/journal/v1/schemas/record.schema.json`, so schema and runtime
//! cannot drift apart unnoticed: a record this decoder accepts must be
//! schema-valid, and one it rejects must be schema-invalid unless the
//! expectation says the rule is outside what a JSON Schema can express.

use aizu_store_jsonl::{decode_record, encode_record};
use aizu_testkit::conformance::{self, Direction};

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
        assert_eq!(
            json(&encode_record(&entry)),
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
