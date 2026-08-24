//! Every example under `spec/protocol/v1/examples` must decode, and
//! re-encoding the decoded value must reproduce the example exactly.

use std::fs;
use std::path::{Path, PathBuf};

use aizign_protocol::{
    Disposition, ReconciliationDisposition, Request, RequestKind, ResponseBody, decode_request,
    decode_response, encode_request, encode_response,
};

fn examples_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/protocol/v1/examples")
}

fn examples(suffix: &str) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = fs::read_dir(examples_dir())
        .expect("examples directory")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.to_string_lossy().ends_with(suffix))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no examples ending in {suffix}");
    files
        .into_iter()
        .map(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            (name, fs::read(&path).expect("read example"))
        })
        .collect()
}

fn json(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).expect("example is JSON")
}

#[test]
fn request_examples_round_trip() {
    for (name, bytes) in examples(".request.json") {
        let request =
            decode_request(&bytes).unwrap_or_else(|failure| panic!("{name}: {failure:?}"));
        let encoded = encode_request(&request);
        assert_eq!(json(encoded.as_bytes()), json(&bytes), "{name}");
        assert!(!encoded.contains('\n'), "{name}: frames are single lines");
    }
}

#[test]
fn response_examples_round_trip() {
    for (name, bytes) in examples(".response.json") {
        let response = decode_response(&bytes).unwrap_or_else(|error| panic!("{name}: {error}"));
        let encoded = encode_response(&response);
        assert_eq!(json(encoded.as_bytes()), json(&bytes), "{name}");
        assert!(!encoded.contains('\n'), "{name}: frames are single lines");
    }
}

#[test]
fn hello_example_decodes_to_hello() {
    let (_, bytes) = examples("hello.request.json").remove(0);
    assert_eq!(
        decode_request(&bytes).unwrap(),
        Request {
            request_id: "req-hello-01".to_owned(),
            kind: RequestKind::Hello
        }
    );
}

#[test]
fn accepted_and_duplicate_examples_carry_dispositions() {
    let (_, accepted) = examples("workflow-signal-submit.accepted.response.json").remove(0);
    let ResponseBody::WorkflowSignal(result) = decode_response(&accepted).unwrap().body else {
        panic!("expected a workflow signal result");
    };
    assert_eq!(result.disposition, Disposition::Accepted);
    assert_eq!(result.event_id.as_str(), "evt-0001");

    let (_, duplicate) = examples("duplicate.response.json").remove(0);
    let ResponseBody::WorkflowSignal(result) = decode_response(&duplicate).unwrap().body else {
        panic!("expected a workflow signal result");
    };
    assert_eq!(result.disposition, Disposition::Duplicate);
}

#[test]
fn reconciliation_examples_carry_each_snapshot_disposition() {
    for (suffix, expected) in [
        (
            "workflow-signal-reconcile.accepted.response.json",
            ReconciliationDisposition::Accepted,
        ),
        (
            "workflow-signal-reconcile.conflict.response.json",
            ReconciliationDisposition::Conflict,
        ),
        (
            "workflow-signal-reconcile.absent.response.json",
            ReconciliationDisposition::Absent,
        ),
    ] {
        let (_, bytes) = examples(suffix).remove(0);
        let ResponseBody::WorkflowSignalReconciliation(result) =
            decode_response(&bytes).unwrap().body
        else {
            panic!("expected a reconciliation result")
        };
        assert_eq!(result.disposition, expected);
        assert_eq!(result.event_id.as_str(), "evt-0001");
    }
}

#[test]
fn rejected_example_carries_a_workflow_code() {
    let (_, bytes) = examples("rejected.response.json").remove(0);
    let response = decode_response(&bytes).unwrap();
    let ResponseBody::Error(error) = response.body else {
        panic!("expected an error")
    };
    assert_eq!(error.code().as_str(), "REVISION_MISMATCH");
    assert_eq!(response.request_id.as_deref(), Some("req-signal-01"));
}
