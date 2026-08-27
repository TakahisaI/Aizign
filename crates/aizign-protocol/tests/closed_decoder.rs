//! The decoder is closed: every malformed frame gets a stable code, and
//! correlation data is recovered whenever it is safe to do so.

use aizign_protocol::{
    BOOTSTRAP_ENVELOPE_VERSION, MAX_FRAME_BYTES, MAX_REQUEST_BYTES, Request, RequestKind, Response,
    ResponseBody, codes, decode_request, decode_response, encode_request, encode_response,
};

fn hello(extra: &str) -> String {
    format!(
        r#"{{"protocol":"aizign","version":1,"requestId":"req-1","kind":"hello","payload":{{}}{extra}}}"#
    )
}

fn code_of(frame: &str) -> (Option<String>, Option<String>, String) {
    let failure = decode_request(frame.as_bytes()).expect_err("frame must be rejected");
    (
        failure.request_id,
        failure.kind,
        failure.error.code().as_str().to_owned(),
    )
}

#[test]
fn well_formed_hello_is_accepted() {
    assert_eq!(
        decode_request(hello("").as_bytes()).unwrap(),
        Request {
            request_id: "req-1".to_owned(),
            kind: RequestKind::Hello
        }
    );
}

#[test]
fn oversized_frames_are_rejected_before_parsing() {
    let padding = " ".repeat(MAX_REQUEST_BYTES);
    let frame = format!("{}{padding}", hello(""));
    assert_eq!(
        code_of(&frame),
        (None, None, codes::REQUEST_TOO_LARGE.to_owned())
    );
}

#[test]
fn non_json_and_non_objects_are_invalid_envelopes() {
    assert_eq!(
        code_of("not json"),
        (None, None, codes::INVALID_ENVELOPE.to_owned())
    );
    assert_eq!(
        code_of("[1,2]"),
        (None, None, codes::INVALID_ENVELOPE.to_owned())
    );
    assert_eq!(
        code_of(""),
        (None, None, codes::INVALID_ENVELOPE.to_owned())
    );
}

#[test]
fn wrong_protocol_name_is_an_invalid_envelope_with_recovered_ids() {
    let frame =
        r#"{"protocol":"other","version":1,"requestId":"req-2","kind":"hello","payload":{}}"#;
    assert_eq!(
        code_of(frame),
        (
            Some("req-2".to_owned()),
            Some("hello".to_owned()),
            codes::INVALID_ENVELOPE.to_owned()
        )
    );
}

#[test]
fn newer_versions_are_reported_with_recovered_ids_even_with_unknown_fields() {
    let frame = r#"{"protocol":"aizign","version":2,"requestId":"req-3","kind":"hello","payload":{},"futureField":true}"#;
    assert_eq!(
        code_of(frame),
        (
            Some("req-3".to_owned()),
            Some("hello".to_owned()),
            codes::PROTOCOL_VERSION_UNSUPPORTED.to_owned()
        )
    );
    let frame =
        r#"{"protocol":"aizign","version":"1","requestId":"req-3","kind":"hello","payload":{}}"#;
    assert_eq!(code_of(frame).2, codes::INVALID_ENVELOPE);
}

#[test]
fn version_axis_selection_precedes_kind_membership() {
    for kind in [
        "hello",
        "workflow.signal.submit",
        "workflow.signal.reconcile",
        "future.operation",
    ] {
        let frame = format!(
            r#"{{"protocol":"aizign","version":2,"requestId":"req-axis","kind":"{kind}","payload":{{}}}}"#
        );
        assert_eq!(code_of(&frame).2, codes::PROTOCOL_VERSION_UNSUPPORTED);
    }

    let accepted_future = r#"{"protocol":"aizign","version":1,"requestId":"req-axis","kind":"future.operation","payload":{}}"#;
    assert_eq!(code_of(accepted_future).2, codes::UNKNOWN_KIND);

    let non_string_kind =
        r#"{"protocol":"aizign","version":2,"requestId":"req-axis","kind":17,"payload":{}}"#;
    assert_eq!(code_of(non_string_kind).2, codes::INVALID_ENVELOPE);
}

#[test]
fn unknown_envelope_fields_are_rejected() {
    assert_eq!(code_of(&hello(r#","extra":1"#)).2, codes::INVALID_ENVELOPE);
}

#[test]
fn missing_fields_are_rejected() {
    let frame = r#"{"protocol":"aizign","version":1,"kind":"hello","payload":{}}"#;
    assert_eq!(
        code_of(frame),
        (
            None,
            Some("hello".to_owned()),
            codes::INVALID_ENVELOPE.to_owned()
        )
    );
    let frame = r#"{"protocol":"aizign","version":1,"requestId":"req-4","kind":"hello"}"#;
    assert_eq!(code_of(frame).2, codes::INVALID_ENVELOPE);
}

#[test]
fn malformed_request_ids_are_rejected_and_not_echoed() {
    let frame =
        r#"{"protocol":"aizign","version":1,"requestId":"bad id","kind":"hello","payload":{}}"#;
    assert_eq!(
        code_of(frame),
        (
            None,
            Some("hello".to_owned()),
            codes::INVALID_ENVELOPE.to_owned()
        )
    );
    let long = "r".repeat(129);
    let frame = format!(
        r#"{{"protocol":"aizign","version":1,"requestId":"{long}","kind":"hello","payload":{{}}}}"#
    );
    assert_eq!(code_of(&frame).0, None);
}

#[test]
fn unknown_kinds_are_rejected_with_recovered_ids() {
    let frame = r#"{"protocol":"aizign","version":1,"requestId":"req-5","kind":"workflow.other","payload":{}}"#;
    assert_eq!(
        code_of(frame),
        (
            Some("req-5".to_owned()),
            Some("workflow.other".to_owned()),
            codes::UNKNOWN_KIND.to_owned()
        )
    );
}

#[test]
fn hello_payload_must_be_an_empty_object() {
    let frame =
        r#"{"protocol":"aizign","version":1,"requestId":"req-6","kind":"hello","payload":{"x":1}}"#;
    assert_eq!(code_of(frame).2, codes::INVALID_PAYLOAD);
    let frame =
        r#"{"protocol":"aizign","version":1,"requestId":"req-6","kind":"hello","payload":[]}"#;
    assert_eq!(
        code_of(frame).2,
        codes::INVALID_ENVELOPE,
        "payload must be an object at the envelope level"
    );
}

#[test]
fn submit_payload_shape_errors_are_invalid_payload() {
    let frame = r#"{"protocol":"aizign","version":1,"requestId":"req-7","kind":"workflow.signal.submit","payload":{"expected":{}}}"#;
    assert_eq!(code_of(frame).2, codes::INVALID_PAYLOAD);
}

#[test]
fn responses_are_closed_too() {
    let frame = r#"{"protocol":"aizign","version":1,"requestId":"r","kind":"hello","ok":true,"payload":{"protocolVersion":1,"journalSchemaVersion":1,"capabilities":[],"package":{"name":"aizign","version":"0.1.0"}},"extra":1}"#;
    assert_eq!(
        decode_response(frame.as_bytes())
            .unwrap_err()
            .code()
            .as_str(),
        codes::INVALID_ENVELOPE
    );

    let frame = r#"{"protocol":"aizign","version":1,"requestId":"r","kind":"hello","ok":true,"error":{"code":"X","message":""}}"#;
    assert_eq!(
        decode_response(frame.as_bytes())
            .unwrap_err()
            .code()
            .as_str(),
        codes::INVALID_ENVELOPE
    );

    let frame = r#"{"protocol":"aizign","version":1,"requestId":"r","kind":"hello","ok":false,"error":{"code":"INVALID_PAYLOAD","message":"m"}}"#;
    let response = decode_response(frame.as_bytes()).unwrap();
    assert!(
        matches!(response.body, ResponseBody::Error(ref error) if error.code().as_str() == codes::INVALID_PAYLOAD)
    );
}

#[test]
fn encoded_frames_carry_the_protocol_version_and_escape_newlines() {
    let response = Response {
        request_id: None,
        kind: None,
        body: ResponseBody::Error(aizign_protocol::ProtocolError::new(
            codes::INTERNAL,
            "line one\nline two",
        )),
    };
    let frame = encode_response(&response).unwrap();
    assert!(!frame.contains('\n'));
    assert!(frame.contains(&format!("\"version\":{BOOTSTRAP_ENVELOPE_VERSION}")));
    assert_eq!(decode_response(frame.as_bytes()).unwrap(), response);

    let request = Request {
        request_id: "req-8".to_owned(),
        kind: RequestKind::Hello,
    };
    assert_eq!(
        decode_request(encode_request(&request).unwrap().as_bytes()).unwrap(),
        request
    );
}

#[test]
fn request_encoder_refuses_a_frame_above_the_bound() {
    let request = Request {
        request_id: "r".repeat(MAX_REQUEST_BYTES),
        kind: RequestKind::Hello,
    };
    let error = encode_request(&request).unwrap_err();
    assert_eq!(error.code().as_str(), codes::REQUEST_TOO_LARGE);
}

#[test]
fn response_encoder_refuses_a_frame_above_the_bound() {
    let response = Response {
        request_id: Some("req-oversized".to_owned()),
        kind: Some("workflow.signal.submit".to_owned()),
        body: ResponseBody::Error(aizign_protocol::ProtocolError::new(
            codes::INTERNAL,
            "x".repeat(MAX_FRAME_BYTES),
        )),
    };
    let error = encode_response(&response).unwrap_err();
    assert_eq!(error.code().as_str(), codes::INVALID_ENVELOPE);
}
