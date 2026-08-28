//! Decoder-independent encoder coverage against every Protocol v1 example.
//!
//! The examples are loaded only as generic JSON values for expected output.
//! Outbound domain values are built directly and passed to the production
//! encoders. `spec/test/schema.test.mjs` validates the same examples, so JSON
//! value equality keeps schema validation in the existing repository gate.

use std::fs;
use std::path::{Path, PathBuf};

use aizign_core::workflow::{
    Command, ExpectedAssignment, Role, SignalKind, SignalParts, WorkflowSignal,
};
use aizign_core::{
    ArtifactRef, ArtifactRevision, AssignmentId, AttemptId, Digest, DigestAlgorithm, EventId,
    ShortErrorCode, WorkflowId,
};
use aizign_protocol::{
    CAPABILITY_WORKFLOW_SIGNAL_RECONCILE, CAPABILITY_WORKFLOW_SIGNAL_SUBMIT, Disposition,
    HelloInfo, MAX_FRAME_BYTES, MAX_REQUEST_BYTES, PackageInfo, ProtocolError,
    ReconciliationDisposition, ReconciliationResult, Request, RequestKind, Response, ResponseBody,
    SignalResult, codes, encode_request, encode_response,
};
use serde_json::json;

const SHA256_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA256_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn protocol_error(code: &str, message: impl Into<String>) -> ProtocolError {
    ProtocolError::try_new(code, message).expect("test code is well formed")
}

fn examples_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/protocol/v1/examples")
}

fn example(name: &str) -> serde_json::Value {
    serde_json::from_slice(
        &fs::read(examples_dir().join(name))
            .unwrap_or_else(|error| panic!("{name}: cannot read example: {error}")),
    )
    .unwrap_or_else(|error| panic!("{name}: example is not JSON: {error}"))
}

fn example_names(suffix: &str) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(examples_dir())
        .expect("examples directory")
        .map(|entry| entry.expect("example entry").file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| name.ends_with(suffix))
        .collect();
    names.sort();
    assert!(!names.is_empty(), "no examples ending in {suffix}");
    names
}

fn assert_explicit_coverage<T>(suffix: &str, cases: &[(&str, T)]) {
    let names = cases
        .iter()
        .map(|(name, _)| (*name).to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        example_names(suffix),
        "every Protocol v1 example must have an explicit encoder case"
    );
}

fn assert_frame(name: &str, frame: &str, bound: usize) {
    let bytes = frame.as_bytes();
    assert!(
        bytes.len() <= bound,
        "{name}: encoded frame is {} bytes; bound is {bound}",
        bytes.len()
    );
    assert!(
        !bytes.starts_with(&[0xef, 0xbb, 0xbf]),
        "{name}: frame must not start with a UTF-8 BOM"
    );
    assert!(
        !frame.contains('\n'),
        "{name}: frame contains a raw newline"
    );
    assert!(
        !frame.contains('\r'),
        "{name}: frame contains a raw carriage return"
    );
    assert_eq!(
        frame.trim(),
        frame,
        "{name}: frame contains surrounding whitespace"
    );

    let encoded: serde_json::Value = serde_json::from_str(frame)
        .unwrap_or_else(|error| panic!("{name}: encoded frame is not one JSON value: {error}"));
    assert!(
        encoded.is_object(),
        "{name}: encoded frame is not an object"
    );
    assert_eq!(encoded, example(name), "{name}: JSON value");
}

fn digest() -> Digest {
    digest_from(SHA256_A)
}

fn digest_from(hex: &str) -> Digest {
    Digest::new(DigestAlgorithm::Sha256, hex).expect("valid example digest")
}

fn expected_assignment() -> ExpectedAssignment {
    ExpectedAssignment {
        workflow_id: WorkflowId::new("wf-example-01").expect("valid workflow id"),
        assignment_id: AssignmentId::new("as-implementation-01").expect("valid assignment id"),
        attempt_id: AttemptId::new("attempt-fixture").expect("valid attempt id"),
        role: Role::Implementation,
        artifact_revision: ArtifactRevision::new("rev-c0ffee").expect("valid artifact revision"),
        candidate_digest: digest(),
    }
}

fn review_expected_assignment() -> ExpectedAssignment {
    ExpectedAssignment {
        workflow_id: WorkflowId::new("wf-example-01").expect("valid workflow id"),
        assignment_id: AssignmentId::new("as-review-01").expect("valid assignment id"),
        attempt_id: AttemptId::new("attempt-fixture").expect("valid attempt id"),
        role: Role::Review,
        artifact_revision: ArtifactRevision::new("rev-c0ffee").expect("valid artifact revision"),
        candidate_digest: digest(),
    }
}

fn signal(event_id: &str, kind: SignalKind, short_error_code: Option<&str>) -> WorkflowSignal {
    let expected = expected_assignment();
    WorkflowSignal::validate(SignalParts {
        event_id: EventId::new(event_id).expect("valid event id"),
        workflow_id: expected.workflow_id,
        assignment_id: expected.assignment_id,
        attempt_id: expected.attempt_id,
        role: expected.role,
        artifact_revision: expected.artifact_revision,
        candidate_digest: expected.candidate_digest,
        kind,
        finding_count: None,
        artifact_ref: None,
        short_error_code: short_error_code
            .map(|code| ShortErrorCode::new(code).expect("valid example short error code")),
    })
    .expect("valid example signal")
}

fn implementation_ready(event_id: &str) -> WorkflowSignal {
    signal(event_id, SignalKind::ImplementationReady, None)
}

fn blocked(event_id: &str) -> WorkflowSignal {
    signal(event_id, SignalKind::Blocked, Some("TOOL_UNAVAILABLE"))
}

fn review_findings(event_id: &str) -> WorkflowSignal {
    let expected = review_expected_assignment();
    WorkflowSignal::validate(SignalParts {
        event_id: EventId::new(event_id).expect("valid event id"),
        workflow_id: expected.workflow_id,
        assignment_id: expected.assignment_id,
        attempt_id: expected.attempt_id,
        role: expected.role,
        artifact_revision: expected.artifact_revision,
        candidate_digest: expected.candidate_digest,
        kind: SignalKind::ReviewFindings,
        finding_count: Some(2),
        artifact_ref: Some(
            ArtifactRef::new("review:0123456789abcdef").expect("valid example artifact reference"),
        ),
        short_error_code: None,
    })
    .expect("valid example review signal")
}

fn review_passed(event_id: &str) -> WorkflowSignal {
    let expected = review_expected_assignment();
    WorkflowSignal::validate(SignalParts {
        event_id: EventId::new(event_id).expect("valid event id"),
        workflow_id: expected.workflow_id,
        assignment_id: expected.assignment_id,
        attempt_id: expected.attempt_id,
        role: expected.role,
        artifact_revision: expected.artifact_revision,
        candidate_digest: expected.candidate_digest,
        kind: SignalKind::ReviewPassed,
        finding_count: Some(0),
        artifact_ref: None,
        short_error_code: None,
    })
    .expect("valid review-passed signal")
}

fn repair_submitted(event_id: &str) -> WorkflowSignal {
    let expected = expected_assignment();
    WorkflowSignal::validate(SignalParts {
        event_id: EventId::new(event_id).expect("valid event id"),
        workflow_id: expected.workflow_id,
        assignment_id: expected.assignment_id,
        attempt_id: expected.attempt_id,
        role: expected.role,
        artifact_revision: expected.artifact_revision,
        candidate_digest: expected.candidate_digest,
        kind: SignalKind::RepairSubmitted,
        finding_count: Some(1),
        artifact_ref: Some(
            ArtifactRef::new("repair:0123456789abcdef").expect("valid example artifact reference"),
        ),
        short_error_code: None,
    })
    .expect("valid repair-submitted signal")
}

fn submit_request(
    request_id: &str,
    expected: ExpectedAssignment,
    signal: WorkflowSignal,
) -> Request {
    Request {
        request_id: request_id.to_owned(),
        kind: RequestKind::SubmitWorkflowSignal(Box::new(Command::SubmitSignal {
            signal,
            expected,
        })),
    }
}

fn response(request_id: Option<&str>, kind: Option<&str>, body: ResponseBody) -> Response {
    let version = match (&body, kind) {
        (ResponseBody::Hello(_), _) | (ResponseBody::Error(_), None | Some("hello")) => {
            aizign_protocol::ResponseVersion::bootstrap()
        }
        _ => aizign_protocol::ResponseVersion::operation(),
    };
    Response {
        version,
        request_id: request_id.map(str::to_owned),
        kind: kind.map(str::to_owned),
        body,
    }
}

fn event_id() -> EventId {
    EventId::new("evt-0001").expect("valid event id")
}

#[test]
fn request_encoders_match_every_protocol_example_without_decoding() {
    let cases = [
        (
            "hello.request.json",
            Request {
                request_id: "req-hello-01".to_owned(),
                kind: RequestKind::Hello,
            },
        ),
        (
            "workflow-signal-reconcile.request.json",
            Request {
                request_id: "req-reconcile-01".to_owned(),
                kind: RequestKind::ReconcileWorkflowSignal(Box::new(implementation_ready(
                    "evt-0001",
                ))),
            },
        ),
        (
            "workflow-signal-submit.blocked.request.json",
            submit_request("req-signal-03", expected_assignment(), blocked("evt-0003")),
        ),
        (
            "workflow-signal-submit.request.json",
            submit_request(
                "req-signal-01",
                expected_assignment(),
                implementation_ready("evt-0001"),
            ),
        ),
        (
            "workflow-signal-submit.review-findings.request.json",
            submit_request(
                "req-signal-02",
                review_expected_assignment(),
                review_findings("evt-0002"),
            ),
        ),
    ];
    assert_explicit_coverage(".request.json", &cases);

    for (name, request) in cases {
        let frame =
            encode_request(&request).unwrap_or_else(|error| panic!("{name}: encode: {error}"));
        assert_frame(name, &frame, MAX_REQUEST_BYTES);
    }
}

#[test]
fn submit_request_encoder_preserves_expected_and_signal_field_provenance() {
    let expected = ExpectedAssignment {
        workflow_id: WorkflowId::new("wf-expected").expect("valid workflow id"),
        assignment_id: AssignmentId::new("as-expected").expect("valid assignment id"),
        attempt_id: AttemptId::new("attempt-expected").expect("valid attempt id"),
        role: Role::Review,
        artifact_revision: ArtifactRevision::new("rev-expected").expect("valid artifact revision"),
        candidate_digest: digest_from(SHA256_B),
    };
    let signal = WorkflowSignal::validate(SignalParts {
        event_id: EventId::new("evt-provenance").expect("valid event id"),
        workflow_id: WorkflowId::new("wf-signal").expect("valid workflow id"),
        assignment_id: AssignmentId::new("as-signal").expect("valid assignment id"),
        attempt_id: AttemptId::new("attempt-signal").expect("valid attempt id"),
        role: Role::Implementation,
        artifact_revision: ArtifactRevision::new("rev-signal").expect("valid artifact revision"),
        candidate_digest: digest_from(SHA256_A),
        kind: SignalKind::ImplementationReady,
        finding_count: None,
        artifact_ref: None,
        short_error_code: None,
    })
    .expect("valid provenance signal");
    let request = submit_request("req-provenance", expected, signal);
    let frame = encode_request(&request).expect("provenance request encodes");
    let encoded: serde_json::Value = serde_json::from_str(&frame).expect("encoded JSON");

    assert_eq!(
        encoded["payload"]["expected"],
        json!({
            "workflowId": "wf-expected",
            "assignmentId": "as-expected",
            "attemptId": "attempt-expected",
            "role": "review",
            "artifactRevision": "rev-expected",
            "candidateDigest": { "algorithm": "sha256", "hex": SHA256_B },
        })
    );
    assert_eq!(
        encoded["payload"]["signal"],
        json!({
            "eventId": "evt-provenance",
            "workflowId": "wf-signal",
            "assignmentId": "as-signal",
            "attemptId": "attempt-signal",
            "role": "implementation",
            "artifactRevision": "rev-signal",
            "candidateDigest": { "algorithm": "sha256", "hex": SHA256_A },
            "kind": "implementation_ready",
        })
    );
}

#[test]
fn request_encoder_covers_every_workflow_signal_kind_and_its_optional_fields() {
    let cases = [
        (implementation_ready("evt-kind-01"), None, None, None),
        (
            review_findings("evt-kind-02"),
            Some(2),
            Some("review:0123456789abcdef"),
            None,
        ),
        (review_passed("evt-kind-03"), Some(0), None, None),
        (
            repair_submitted("evt-kind-04"),
            Some(1),
            Some("repair:0123456789abcdef"),
            None,
        ),
        (blocked("evt-kind-05"), None, None, Some("TOOL_UNAVAILABLE")),
    ];

    for (signal, finding_count, artifact_ref, short_error_code) in cases {
        let kind = match signal.kind() {
            SignalKind::ImplementationReady => "implementation_ready",
            SignalKind::ReviewFindings => "review_findings",
            SignalKind::ReviewPassed => "review_passed",
            SignalKind::RepairSubmitted => "repair_submitted",
            SignalKind::Blocked => "blocked",
        };
        let request = Request {
            request_id: format!("req-{kind}"),
            kind: RequestKind::ReconcileWorkflowSignal(Box::new(signal)),
        };
        let frame = encode_request(&request).expect("signal kind request encodes");
        let encoded: serde_json::Value = serde_json::from_str(&frame).expect("encoded JSON");
        let wire_signal = encoded["payload"]["signal"]
            .as_object()
            .expect("signal is an object");

        assert_eq!(wire_signal["kind"], json!(kind));
        assert_eq!(
            wire_signal
                .get("findingCount")
                .and_then(serde_json::Value::as_u64),
            finding_count
        );
        assert_eq!(
            wire_signal
                .get("artifactRef")
                .and_then(serde_json::Value::as_str),
            artifact_ref
        );
        assert_eq!(
            wire_signal
                .get("shortErrorCode")
                .and_then(serde_json::Value::as_str),
            short_error_code
        );
        assert_eq!(
            wire_signal.len(),
            8 + usize::from(finding_count.is_some())
                + usize::from(artifact_ref.is_some())
                + usize::from(short_error_code.is_some()),
            "{kind}: unexpected signal fields"
        );
    }
}

fn envelope_response_cases() -> [(&'static str, Response); 3] {
    [
        (
            "hello.response.json",
            response(
                Some("req-hello-01"),
                Some("hello"),
                ResponseBody::Hello(HelloInfo {
                    protocol_version: 1,
                    journal_schema_version: 1,
                    capabilities: vec![
                        CAPABILITY_WORKFLOW_SIGNAL_SUBMIT.to_owned(),
                        CAPABILITY_WORKFLOW_SIGNAL_RECONCILE.to_owned(),
                    ],
                    package: PackageInfo {
                        name: "aizign".to_owned(),
                        version: "0.1.0".to_owned(),
                    },
                }),
            ),
        ),
        (
            "invalid-envelope.response.json",
            response(
                None,
                None,
                ResponseBody::Error(protocol_error(
                    codes::INVALID_ENVELOPE,
                    "expected value at line 1 column 1",
                )),
            ),
        ),
        (
            "version-unsupported.response.json",
            response(
                Some("req-future-01"),
                Some("hello"),
                ResponseBody::Error(protocol_error(
                    codes::PROTOCOL_VERSION_UNSUPPORTED,
                    "protocol version 2 is not supported; this binary speaks 1",
                )),
            ),
        ),
    ]
}

fn reconciliation_response_cases() -> [(&'static str, Response); 3] {
    [
        (
            "workflow-signal-reconcile.absent.response.json",
            response(
                Some("req-reconcile-01"),
                Some("workflow.signal.reconcile"),
                ResponseBody::WorkflowSignalReconciliation(ReconciliationResult {
                    disposition: ReconciliationDisposition::Absent,
                    event_id: event_id(),
                }),
            ),
        ),
        (
            "workflow-signal-reconcile.accepted.response.json",
            response(
                Some("req-reconcile-01"),
                Some("workflow.signal.reconcile"),
                ResponseBody::WorkflowSignalReconciliation(ReconciliationResult {
                    disposition: ReconciliationDisposition::Accepted,
                    event_id: event_id(),
                }),
            ),
        ),
        (
            "workflow-signal-reconcile.conflict.response.json",
            response(
                Some("req-reconcile-01"),
                Some("workflow.signal.reconcile"),
                ResponseBody::WorkflowSignalReconciliation(ReconciliationResult {
                    disposition: ReconciliationDisposition::Conflict,
                    event_id: event_id(),
                }),
            ),
        ),
    ]
}

fn submit_response_cases() -> [(&'static str, Response); 3] {
    [
        (
            "workflow-signal-submit.accepted.response.json",
            response(
                Some("req-signal-01"),
                Some("workflow.signal.submit"),
                ResponseBody::WorkflowSignal(SignalResult {
                    disposition: Disposition::Accepted,
                    event_id: event_id(),
                }),
            ),
        ),
        (
            "workflow-signal-submit.duplicate.response.json",
            response(
                Some("req-signal-01"),
                Some("workflow.signal.submit"),
                ResponseBody::WorkflowSignal(SignalResult {
                    disposition: Disposition::Duplicate,
                    event_id: event_id(),
                }),
            ),
        ),
        (
            "workflow-signal-submit.rejected.response.json",
            response(
                Some("req-signal-01"),
                Some("workflow.signal.submit"),
                ResponseBody::Error(protocol_error(
                    "REVISION_MISMATCH",
                    "revision mismatch: expected rev-c0ffee, got rev-deadbeef",
                )),
            ),
        ),
    ]
}

#[test]
fn response_encoders_match_every_protocol_example_without_decoding() {
    let cases = envelope_response_cases()
        .into_iter()
        .chain(reconciliation_response_cases())
        .chain(submit_response_cases())
        .collect::<Vec<_>>();
    assert_explicit_coverage(".response.json", &cases);

    for (name, response) in cases {
        let frame =
            encode_response(&response).unwrap_or_else(|error| panic!("{name}: encode: {error}"));
        assert_frame(name, &frame, MAX_FRAME_BYTES);
    }
}

#[test]
fn response_encoder_checks_success_kind_membership_before_body_mapping() {
    let success_bodies = [
        ResponseBody::Hello(HelloInfo {
            protocol_version: 1,
            journal_schema_version: 1,
            capabilities: Vec::new(),
            package: PackageInfo {
                name: "aizign".to_owned(),
                version: "0.1.0".to_owned(),
            },
        }),
        ResponseBody::WorkflowSignal(SignalResult {
            disposition: Disposition::Accepted,
            event_id: event_id(),
        }),
        ResponseBody::WorkflowSignalReconciliation(ReconciliationResult {
            disposition: ReconciliationDisposition::Absent,
            event_id: event_id(),
        }),
    ];
    for body in success_bodies {
        let invalid_bootstrap_context = Response {
            version: aizign_protocol::ResponseVersion::Bootstrap(7),
            request_id: Some("req-future-success".to_owned()),
            kind: Some("future.operation".to_owned()),
            body: body.clone(),
        };
        assert_eq!(
            encode_response(&invalid_bootstrap_context)
                .unwrap_err()
                .code()
                .as_str(),
            codes::INVALID_ENVELOPE
        );

        let response = Response {
            version: aizign_protocol::ResponseVersion::operation(),
            request_id: Some("req-future-success".to_owned()),
            kind: Some("future.operation".to_owned()),
            body,
        };
        assert_eq!(
            encode_response(&response).unwrap_err().code().as_str(),
            codes::UNKNOWN_KIND
        );
    }

    let wrong_mapping = Response {
        version: aizign_protocol::ResponseVersion::operation(),
        request_id: Some("req-wrong-success".to_owned()),
        kind: Some("workflow.signal.reconcile".to_owned()),
        body: ResponseBody::WorkflowSignal(SignalResult {
            disposition: Disposition::Accepted,
            event_id: event_id(),
        }),
    };
    assert_eq!(
        encode_response(&wrong_mapping).unwrap_err().code().as_str(),
        codes::INVALID_ENVELOPE
    );

    let null_kind = Response {
        version: aizign_protocol::ResponseVersion::bootstrap(),
        request_id: Some("req-null-success".to_owned()),
        kind: None,
        body: ResponseBody::Hello(HelloInfo {
            protocol_version: 1,
            journal_schema_version: 1,
            capabilities: Vec::new(),
            package: PackageInfo {
                name: "aizign".to_owned(),
                version: "0.1.0".to_owned(),
            },
        }),
    };
    assert_eq!(
        encode_response(&null_kind).unwrap_err().code().as_str(),
        codes::INVALID_ENVELOPE
    );
}

#[test]
fn response_encoder_preserves_event_id_provenance() {
    let cases = [
        response(
            Some("req-submit-provenance"),
            Some("workflow.signal.submit"),
            ResponseBody::WorkflowSignal(SignalResult {
                disposition: Disposition::Accepted,
                event_id: EventId::new("evt-submit-provenance").expect("valid event id"),
            }),
        ),
        response(
            Some("req-reconcile-provenance"),
            Some("workflow.signal.reconcile"),
            ResponseBody::WorkflowSignalReconciliation(ReconciliationResult {
                disposition: ReconciliationDisposition::Conflict,
                event_id: EventId::new("evt-reconcile-provenance").expect("valid event id"),
            }),
        ),
    ];

    for response in cases {
        let expected_event_id = match &response.body {
            ResponseBody::WorkflowSignal(result) => result.event_id.to_string(),
            ResponseBody::WorkflowSignalReconciliation(result) => result.event_id.to_string(),
            _ => unreachable!("provenance cases carry event ids"),
        };
        let frame = encode_response(&response).expect("provenance response encodes");
        let encoded: serde_json::Value = serde_json::from_str(&frame).expect("encoded JSON");
        assert_eq!(encoded["payload"]["eventId"], json!(expected_event_id));
    }
}

#[test]
fn response_encoder_accepts_exactly_the_bound_and_rejects_the_next_byte() {
    let make = |message: String| {
        response(
            Some("req-bound"),
            Some("workflow.signal.submit"),
            ResponseBody::Error(protocol_error(codes::INTERNAL, message)),
        )
    };
    let overhead = encode_response(&make(String::new()))
        .expect("empty response encodes")
        .len();
    let exact = encode_response(&make("x".repeat(MAX_FRAME_BYTES - overhead)))
        .expect("exact-bound response encodes");
    assert_eq!(exact.len(), MAX_FRAME_BYTES);
    assert_eq!(
        encode_response(&make("x".repeat(MAX_FRAME_BYTES - overhead + 1)))
            .expect_err("over-bound response fails")
            .code()
            .as_str(),
        codes::INVALID_ENVELOPE
    );
}
