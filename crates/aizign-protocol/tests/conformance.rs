//! The Rust decoder against every language-neutral fixture in
//! `spec/conformance`. The TypeScript implementation runs the same files.

use aizign_protocol::{decode_request, decode_response, encode_request, encode_response};
use aizign_testkit::conformance::{self, Direction};

fn json(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).expect("frame is JSON")
}

#[test]
fn valid_requests_decode_and_round_trip() {
    for fixture in conformance::valid(Direction::Request) {
        let request = decode_request(&fixture.frame)
            .unwrap_or_else(|failure| panic!("{}: {failure:?}", fixture.name));
        let encoded = encode_request(&request);
        assert_eq!(
            json(encoded.as_bytes()),
            json(&fixture.frame),
            "{}",
            fixture.name
        );
    }
}

#[test]
fn valid_responses_decode_and_round_trip() {
    for fixture in conformance::valid(Direction::Response) {
        let response = decode_response(&fixture.frame)
            .unwrap_or_else(|error| panic!("{}: {error}", fixture.name));
        let encoded = encode_response(&response);
        assert_eq!(
            json(encoded.as_bytes()),
            json(&fixture.frame),
            "{}",
            fixture.name
        );
    }
}

#[test]
fn invalid_requests_fail_with_the_expected_code_and_recovered_ids() {
    for fixture in conformance::invalid(Direction::Request) {
        let failure = decode_request(&fixture.frame)
            .err()
            .unwrap_or_else(|| panic!("{}: must be rejected", fixture.name));
        assert_eq!(
            failure.error.code().as_str(),
            fixture.code,
            "{}: code",
            fixture.name
        );
        assert_eq!(
            failure.request_id, fixture.request_id,
            "{}: requestId",
            fixture.name
        );
        assert_eq!(failure.kind, fixture.kind, "{}: kind", fixture.name);
    }
}

#[test]
fn invalid_responses_fail_with_the_expected_code() {
    for fixture in conformance::invalid(Direction::Response) {
        let error = decode_response(&fixture.frame)
            .err()
            .unwrap_or_else(|| panic!("{}: must be rejected", fixture.name));
        assert_eq!(
            error.code().as_str(),
            fixture.code,
            "{}: code",
            fixture.name
        );
    }
}
