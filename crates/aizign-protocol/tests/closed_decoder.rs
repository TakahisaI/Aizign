//! The decoder is closed: every malformed frame gets a stable code, and
//! correlation data is recovered whenever it is safe to do so.

use aizign_protocol::{
    BOOTSTRAP_ENVELOPE_VERSION, MAX_FRAME_BYTES, MAX_REQUEST_BYTES, Request, RequestKind, Response,
    ResponseBody, ResponseVersion, codes, decode_request, decode_response, decode_response_for,
    encode_request, encode_response,
};

fn protocol_error(code: &str, message: impl Into<String>) -> aizign_protocol::ProtocolError {
    aizign_protocol::ProtocolError::try_new(code, message).expect("test code is well formed")
}

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
fn malformed_json_grammar_is_rejected_before_correlation_recovery() {
    for value in ["1e", "1.", "01", "-", r#""\q""#, r#""\u12""#] {
        let frame = format!(
            r#"{{"protocol":"aizign","version":1,"requestId":"req-syntax","kind":"hello","payload":{{"value":{value}}}}}"#
        );
        let failure = decode_request(frame.as_bytes()).unwrap_err();
        assert_eq!(
            failure.error.code().as_str(),
            codes::INVALID_ENVELOPE,
            "{value}"
        );
        assert_eq!(failure.request_id, None, "{value}");
        assert_eq!(failure.kind, None, "{value}");
        assert_eq!(
            failure.response_version,
            ResponseVersion::bootstrap(),
            "{value}"
        );
    }
}

#[test]
fn an_ill_formed_top_level_kind_is_not_recovered() {
    let frame = r#"{"protocol":"aizign","version":1,"requestId":"req-unicode","kind":"\uD800","payload":{}}"#;
    let failure = decode_request(frame.as_bytes()).unwrap_err();
    assert_eq!(failure.error.code().as_str(), codes::INVALID_ENVELOPE);
    assert_eq!(failure.request_id.as_deref(), Some("req-unicode"));
    assert_eq!(failure.kind, None);
}

#[test]
fn an_ill_formed_top_level_member_name_suppresses_all_correlation() {
    let request_frames = [
        String::from(
            r#"{"\uD800":0,"protocol":"aizign","version":1,"requestId":"req-before","kind":"hello","payload":{}}"#,
        ),
        String::from(
            r#"{"protocol":"aizign","version":1,"requestId":"req-between","\uD800":0,"kind":"hello","payload":{}}"#,
        ),
        String::from(
            r#"{"protocol":"aizign","version":1,"requestId":"req-after","kind":"hello","\uD800":0,"payload":{}}"#,
        ),
        String::from(
            r#"{"protocol":"aizign","version":1,"requestId":"req-old","requestId":"req-final","kind":"hello","\uD800":0,"payload":{}}"#,
        ),
        String::from(
            r#"{"protocol":"aizign","version":2,"requestId":"req-version","kind":"hello","\uD800":0,"payload":{}}"#,
        ),
    ];
    for frame in request_frames {
        let failure = decode_request(frame.as_bytes()).unwrap_err();
        assert_eq!(failure.code().as_str(), codes::INVALID_ENVELOPE, "{frame}");
        assert_eq!(failure.request_id, None, "{frame}");
        assert_eq!(failure.kind, None, "{frame}");
        assert_eq!(
            failure.response_version,
            ResponseVersion::bootstrap(),
            "{frame}"
        );
    }

    let response_frames = [
        String::from(
            r#"{"\uD800":0,"protocol":"aizign","version":2,"requestId":"req-before","kind":"workflow.signal.submit","ok":false,"error":{"code":"INTERNAL","message":"x"}}"#,
        ),
        String::from(
            r#"{"protocol":"aizign","version":2,"requestId":"req-between","\uD800":0,"kind":"workflow.signal.submit","ok":false,"error":{"code":"INTERNAL","message":"x"}}"#,
        ),
        String::from(
            r#"{"protocol":"aizign","version":2,"requestId":"req-after","kind":"workflow.signal.submit","\uD800":0,"ok":false,"error":{"code":"INTERNAL","message":"x"}}"#,
        ),
        String::from(
            r#"{"protocol":"aizign","version":2,"requestId":"req-old","requestId":"req-final","kind":"workflow.signal.submit","\uD800":0,"ok":false,"error":{"code":"INTERNAL","message":"x"}}"#,
        ),
        String::from(
            r#"{"protocol":"aizign","version":3,"requestId":"req-version","kind":"workflow.signal.submit","\uD800":0,"ok":false,"error":{"code":"INTERNAL","message":"x"}}"#,
        ),
    ];
    for frame in response_frames {
        let failure = decode_response_for(
            frame.as_bytes(),
            Some(ResponseVersion::AcceptedOperation(2)),
        )
        .unwrap_err();
        assert_eq!(failure.code().as_str(), codes::INVALID_ENVELOPE, "{frame}");
        assert_eq!(failure.request_id, None, "{frame}");
        assert_eq!(failure.kind, None, "{frame}");
        assert_eq!(
            failure.response_version,
            ResponseVersion::AcceptedOperation(2),
            "{frame}"
        );
    }

    let nested = r#"{"protocol":"aizign","version":1,"requestId":"req-nested-key","kind":"hello","payload":{"\uD800":0}}"#;
    let failure = decode_request(nested.as_bytes()).unwrap_err();
    assert_eq!(failure.code().as_str(), codes::INVALID_ENVELOPE);
    assert_eq!(failure.request_id.as_deref(), Some("req-nested-key"));
    assert_eq!(failure.kind.as_deref(), Some("hello"));
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
        version: ResponseVersion::bootstrap(),
        request_id: None,
        kind: None,
        body: ResponseBody::Error(protocol_error(codes::INTERNAL, "line one\nline two")),
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
fn request_encoder_rejects_overlong_fields_before_the_final_bound() {
    let request = Request {
        request_id: "r".repeat(MAX_REQUEST_BYTES),
        kind: RequestKind::Hello,
    };
    let error = encode_request(&request).unwrap_err();
    assert_eq!(error.code().as_str(), codes::INVALID_ENVELOPE);
}

#[test]
fn response_encoder_refuses_a_frame_above_the_bound() {
    let response = Response {
        version: ResponseVersion::operation(),
        request_id: Some("req-oversized".to_owned()),
        kind: Some("workflow.signal.submit".to_owned()),
        body: ResponseBody::Error(protocol_error(codes::INTERNAL, "x".repeat(MAX_FRAME_BYTES))),
    };
    let error = encode_response(&response).unwrap_err();
    assert_eq!(error.code().as_str(), codes::INVALID_ENVELOPE);
}

#[test]
fn huge_canonical_payload_integers_are_payload_failures() {
    let huge = format!("1{}", "0".repeat(400));
    let digest = "a".repeat(64);
    let request = r#"{"protocol":"aizign","version":1,"requestId":"req-huge","kind":"workflow.signal.submit","payload":{"expected":{"workflowId":"wf-1","assignmentId":"as-1","attemptId":"attempt-1","role":"review","artifactRevision":"rev-1","candidateDigest":{"algorithm":"sha256","hex":"$DIGEST"}},"signal":{"eventId":"evt-1","workflowId":"wf-1","assignmentId":"as-1","attemptId":"attempt-1","role":"review","artifactRevision":"rev-1","candidateDigest":{"algorithm":"sha256","hex":"$DIGEST"},"kind":"review_findings","findingCount":$HUGE}}}"#
        .replace("$DIGEST", &digest)
        .replace("$HUGE", &huge);
    assert_eq!(code_of(&request).2, codes::INVALID_PAYLOAD);

    let response = format!(
        r#"{{"protocol":"aizign","version":1,"requestId":"req-huge","kind":"hello","ok":true,"payload":{{"protocolVersion":{huge},"journalSchemaVersion":1,"capabilities":[],"package":{{"name":"aizign","version":"0.1.0"}}}}}}"#
    );
    assert_eq!(
        decode_response(response.as_bytes())
            .unwrap_err()
            .error
            .code()
            .as_str(),
        codes::INVALID_PAYLOAD
    );
}

#[test]
fn success_shape_does_not_select_bootstrap_from_an_error_code() {
    let frame = r#"{"protocol":"aizign","version":2,"requestId":"req-axis-cross-product","kind":"workflow.signal.submit","ok":true,"error":{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"not an error response"}}"#;
    let failure = decode_response_for(
        frame.as_bytes(),
        Some(ResponseVersion::AcceptedOperation(2)),
    )
    .unwrap_err();
    assert_eq!(failure.error.code().as_str(), codes::INVALID_ENVELOPE);
    assert_eq!(
        failure.response_version,
        ResponseVersion::AcceptedOperation(2)
    );
}

#[test]
fn response_encoder_uses_the_explicit_source_qualified_axis() {
    let operation = Response {
        version: ResponseVersion::AcceptedOperation(2),
        request_id: Some("req-future-operation".to_owned()),
        kind: Some("workflow.signal.submit".to_owned()),
        body: ResponseBody::Error(protocol_error(codes::INTERNAL, "operation failed")),
    };
    let bootstrap = Response {
        version: ResponseVersion::Bootstrap(1),
        request_id: operation.request_id.clone(),
        kind: operation.kind.clone(),
        body: operation.body.clone(),
    };

    assert!(
        encode_response(&operation)
            .unwrap()
            .contains("\"version\":2")
    );
    assert!(
        encode_response(&bootstrap)
            .unwrap()
            .contains("\"version\":1")
    );
    assert_eq!(
        encode_response(&Response {
            version: ResponseVersion::Bootstrap(7),
            ..bootstrap
        })
        .unwrap_err()
        .code()
        .as_str(),
        codes::INVALID_ENVELOPE
    );

    let null_kind = Response {
        version: ResponseVersion::operation(),
        request_id: Some("req-unsafe-kind".to_owned()),
        kind: None,
        body: operation.body,
    };
    let encoded = encode_response(&null_kind).unwrap();
    assert_eq!(
        decode_response_for(encoded.as_bytes(), Some(ResponseVersion::operation()),)
            .unwrap()
            .version,
        ResponseVersion::operation()
    );
}

#[test]
fn response_decoder_validates_the_source_stage_and_exact_numeric_version() {
    let operation_v2 = r#"{"protocol":"aizign","version":2,"requestId":"req-operation-v2","kind":"workflow.signal.submit","ok":false,"error":{"code":"INTERNAL","message":"failed"}}"#;
    assert_eq!(
        decode_response_for(
            operation_v2.as_bytes(),
            Some(ResponseVersion::AcceptedOperation(2)),
        )
        .unwrap()
        .version,
        ResponseVersion::AcceptedOperation(2)
    );
    assert_eq!(
        decode_response_for(
            operation_v2.as_bytes(),
            Some(ResponseVersion::AcceptedOperation(3)),
        )
        .unwrap_err()
        .code()
        .as_str(),
        codes::PROTOCOL_VERSION_UNSUPPORTED
    );

    let bootstrap_compatibility = r#"{"protocol":"aizign","version":1,"requestId":"req-operation-v2","kind":"workflow.signal.submit","ok":false,"error":{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"unsupported"}}"#;
    assert_eq!(
        decode_response_for(
            bootstrap_compatibility.as_bytes(),
            Some(ResponseVersion::AcceptedOperation(2)),
        )
        .unwrap()
        .version,
        ResponseVersion::Bootstrap(1)
    );

    let operation_invalid_envelope = r#"{"protocol":"aizign","version":1,"requestId":"req-operation-v1","kind":"workflow.signal.submit","ok":false,"error":{"code":"INVALID_ENVELOPE","message":"closed decode failed"}}"#;
    assert_eq!(
        decode_response_for(
            operation_invalid_envelope.as_bytes(),
            Some(ResponseVersion::AcceptedOperation(1)),
        )
        .unwrap()
        .version,
        ResponseVersion::AcceptedOperation(1)
    );

    let hello_on_operation_version = r#"{"protocol":"aizign","version":2,"requestId":"req-hello","kind":"hello","ok":true,"payload":{"protocolVersion":2,"journalSchemaVersion":1,"capabilities":[],"package":{"name":"future-core","version":"2.0.0"}}}"#;
    assert_eq!(
        decode_response_for(
            hello_on_operation_version.as_bytes(),
            Some(ResponseVersion::AcceptedOperation(2)),
        )
        .unwrap_err()
        .code()
        .as_str(),
        codes::PROTOCOL_VERSION_UNSUPPORTED
    );

    let operation_on_bootstrap_version = r#"{"protocol":"aizign","version":7,"requestId":"req-submit","kind":"workflow.signal.submit","ok":true,"payload":{"disposition":"accepted","eventId":"evt-0001"}}"#;
    assert_eq!(
        decode_response_for(
            operation_on_bootstrap_version.as_bytes(),
            Some(ResponseVersion::Bootstrap(7)),
        )
        .unwrap_err()
        .code()
        .as_str(),
        codes::PROTOCOL_VERSION_UNSUPPORTED
    );
}

#[test]
fn response_axis_requires_a_boolean_false_before_bootstrap_error_selection() {
    for (name, ok_member, expected_axis) in [
        (
            "true",
            r#","ok":true"#,
            ResponseVersion::AcceptedOperation(2),
        ),
        ("missing", "", ResponseVersion::AcceptedOperation(2)),
        (
            "null",
            r#","ok":null"#,
            ResponseVersion::AcceptedOperation(2),
        ),
        (
            "string",
            r#","ok":"false""#,
            ResponseVersion::AcceptedOperation(2),
        ),
    ] {
        let frame = format!(
            r#"{{"protocol":"aizign","version":2,"requestId":"req-ok-{name}","kind":"workflow.signal.submit"{ok_member},"error":{{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"unsupported"}}}}"#
        );
        let failure = decode_response_for(
            frame.as_bytes(),
            Some(ResponseVersion::AcceptedOperation(2)),
        )
        .unwrap_err();
        assert_eq!(failure.response_version, expected_axis, "{name}");
        assert_eq!(failure.code().as_str(), codes::INVALID_ENVELOPE, "{name}");
        assert_eq!(failure.request_id, Some(format!("req-ok-{name}")));
        assert_eq!(failure.kind.as_deref(), Some("workflow.signal.submit"));
    }

    let false_frame = r#"{"protocol":"aizign","version":1,"requestId":"req-ok-false","kind":"workflow.signal.submit","ok":false,"error":{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"unsupported"}}"#;
    let response = decode_response_for(
        false_frame.as_bytes(),
        Some(ResponseVersion::AcceptedOperation(2)),
    )
    .unwrap();
    assert_eq!(response.version, ResponseVersion::Bootstrap(1));
    assert_eq!(response.request_id.as_deref(), Some("req-ok-false"));
    assert_eq!(response.kind.as_deref(), Some("workflow.signal.submit"));
    assert!(matches!(
        response.body,
        ResponseBody::Error(ref error)
            if error.code().as_str() == codes::PROTOCOL_VERSION_UNSUPPORTED
    ));
}

#[test]
fn duplicate_members_recover_only_the_final_typed_spelling() {
    for (name, duplicate, expected_request_id) in [
        ("string-to-number", r#""old","requestId":17"#, None),
        ("string-to-null", r#""old","requestId":null"#, None),
        ("string-to-object", r#""old","requestId":{}"#, None),
        (
            "number-to-string",
            r#"17,"requestId":"req-final""#,
            Some("req-final"),
        ),
    ] {
        let frame = format!(
            r#"{{"protocol":"aizign","version":1,"requestId":{duplicate},"kind":"hello","payload":{{}}}}"#
        );
        let failure = decode_request(frame.as_bytes()).unwrap_err();
        assert_eq!(failure.code().as_str(), codes::INVALID_ENVELOPE, "{name}");
        assert_eq!(failure.request_id.as_deref(), expected_request_id, "{name}");
    }

    for (name, final_ok) in [("false-to-null", "null"), ("false-to-string", r#""false""#)] {
        let frame = format!(
            r#"{{"protocol":"aizign","version":2,"requestId":"req-{name}","kind":"workflow.signal.submit","ok":false,"ok":{final_ok},"error":{{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"unsupported"}}}}"#
        );
        let failure = decode_response_for(
            frame.as_bytes(),
            Some(ResponseVersion::AcceptedOperation(2)),
        )
        .unwrap_err();
        assert_eq!(failure.code().as_str(), codes::INVALID_ENVELOPE, "{name}");
        assert_eq!(
            failure.response_version,
            ResponseVersion::AcceptedOperation(2),
            "{name}"
        );
    }

    let replaced_error = r#"{"protocol":"aizign","version":2,"requestId":"req-error-null","kind":"workflow.signal.submit","ok":false,"error":{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"unsupported"},"error":null}"#;
    let failure = decode_response_for(
        replaced_error.as_bytes(),
        Some(ResponseVersion::AcceptedOperation(2)),
    )
    .unwrap_err();
    assert_eq!(failure.code().as_str(), codes::INVALID_ENVELOPE);
    assert_eq!(
        failure.response_version,
        ResponseVersion::AcceptedOperation(2)
    );
}

#[test]
fn only_a_direct_error_code_can_select_the_bootstrap_response_axis() {
    let nested = r#"{"protocol":"aizign","version":2,"requestId":"req-nested-code","kind":"workflow.signal.submit","ok":false,"error":{"meta":{"code":"PROTOCOL_VERSION_UNSUPPORTED"},"message":"unsupported"}}"#;
    let failure = decode_response_for(
        nested.as_bytes(),
        Some(ResponseVersion::AcceptedOperation(2)),
    )
    .unwrap_err();
    assert_eq!(failure.code().as_str(), codes::INVALID_ENVELOPE);
    assert_eq!(failure.request_id.as_deref(), Some("req-nested-code"));
    assert_eq!(
        failure.response_version,
        ResponseVersion::AcceptedOperation(2)
    );

    let direct = r#"{"protocol":"aizign","version":1,"requestId":"req-direct-code","kind":"workflow.signal.submit","ok":false,"error":{"code":"PROTOCOL_VERSION_UNSUPPORTED","message":"unsupported"}}"#;
    assert_eq!(
        decode_response_for(
            direct.as_bytes(),
            Some(ResponseVersion::AcceptedOperation(2)),
        )
        .unwrap()
        .version,
        ResponseVersion::Bootstrap(1)
    );
}

#[test]
fn deep_future_payloads_are_scanned_before_version_routing_without_a_depth_cutoff() {
    let wrap = |leaf: &str| format!("{}{}{}", r#"{"next":"#.repeat(180), leaf, "}".repeat(180));
    let valid = format!(
        r#"{{"protocol":"aizign","version":2,"requestId":"req-deep","kind":"future.operation","payload":{}}}"#,
        wrap("{}")
    );
    let failure = decode_request(valid.as_bytes()).unwrap_err();
    assert_eq!(failure.code().as_str(), codes::PROTOCOL_VERSION_UNSUPPORTED);
    assert_eq!(failure.request_id.as_deref(), Some("req-deep"));
    assert_eq!(failure.kind.as_deref(), Some("future.operation"));

    let duplicate = format!(
        r#"{{"protocol":"aizign","version":2,"requestId":"req-deep","kind":"future.operation","payload":{}}}"#,
        wrap(r#"{"same":1,"same":2}"#)
    );
    assert_eq!(
        decode_request(duplicate.as_bytes())
            .unwrap_err()
            .code()
            .as_str(),
        codes::INVALID_ENVELOPE
    );
}

#[test]
fn deep_payload_detection_preserves_envelope_and_routing_precedence() {
    let wrap = |leaf: &str| format!("{}{}{}", r#"{"next":"#.repeat(180), leaf, "}".repeat(180));
    let cases = [
        (
            "known-kind",
            format!(
                r#"{{"protocol":"aizign","version":1,"requestId":"req-known","kind":"hello","payload":{}}}"#,
                wrap("{}")
            ),
            codes::INVALID_PAYLOAD,
        ),
        (
            "unknown-kind",
            format!(
                r#"{{"protocol":"aizign","version":1,"requestId":"req-unknown","kind":"future.operation","payload":{}}}"#,
                wrap("{}")
            ),
            codes::UNKNOWN_KIND,
        ),
        (
            "missing-kind",
            format!(
                r#"{{"protocol":"aizign","version":1,"requestId":"req-missing","payload":{}}}"#,
                wrap("{}")
            ),
            codes::INVALID_ENVELOPE,
        ),
        (
            "non-string-kind",
            format!(
                r#"{{"protocol":"aizign","version":1,"requestId":"req-non-string","kind":17,"payload":{}}}"#,
                wrap("{}")
            ),
            codes::INVALID_ENVELOPE,
        ),
        (
            "unknown-envelope-member",
            format!(
                r#"{{"protocol":"aizign","version":1,"requestId":"req-extra","kind":"hello","payload":{},"extra":true}}"#,
                wrap("{}")
            ),
            codes::INVALID_ENVELOPE,
        ),
        (
            "unsupported-version",
            format!(
                r#"{{"protocol":"aizign","version":2,"requestId":"req-version","kind":"hello","payload":{}}}"#,
                wrap("{}")
            ),
            codes::PROTOCOL_VERSION_UNSUPPORTED,
        ),
    ];
    for (name, frame, expected) in cases {
        assert_eq!(code_of(&frame).2, expected, "{name}");
    }
}
