//! Request and response envelopes: the one-line NDJSON frames that cross
//! the process boundary.

use aizign_core::workflow::{Command, WorkflowSignal};
use serde::{Deserialize, Serialize};

use crate::error::{ProtocolError, codes};
use crate::hello::HelloInfo;
use crate::json_token::{FailureKind, scan_json_tokens};
use crate::workflow_signal::{self, ReconciliationResult, SignalResult};

/// Value of the `protocol` field.
pub const PROTOCOL_NAME: &str = "aizign";
/// The wire protocol version this crate implements.
pub const PROTOCOL_VERSION: u32 = 1;
/// Stable envelope version used before an operation version is accepted.
pub const BOOTSTRAP_ENVELOPE_VERSION: u32 = 1;
/// Upper bound on any frame, request or response, in bytes.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
/// Alias kept for callers that only deal with requests.
pub const MAX_REQUEST_BYTES: usize = MAX_FRAME_BYTES;
/// Upper bound on a request id, in bytes.
pub const MAX_REQUEST_ID_LEN: usize = 128;

/// Kind string of the handshake request.
pub const KIND_HELLO: &str = "hello";
/// Kind string of the workflow signal submission.
pub const KIND_WORKFLOW_SIGNAL_SUBMIT: &str = "workflow.signal.submit";
/// Kind string of the read-only workflow signal reconciliation request.
pub const KIND_WORKFLOW_SIGNAL_RECONCILE: &str = "workflow.signal.reconcile";

/// A decoded request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    /// Caller-chosen correlation id, echoed in the response.
    pub request_id: String,
    /// What is being asked.
    pub kind: RequestKind,
}

/// The registered request kinds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequestKind {
    /// Version and capability handshake.
    Hello,
    /// Submit a structured workflow signal for decision.
    SubmitWorkflowSignal(Box<Command>),
    /// Classify a structured signal from a committed journal snapshot.
    ReconcileWorkflowSignal(Box<WorkflowSignal>),
}

impl RequestKind {
    /// The wire `kind` string.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::Hello => KIND_HELLO,
            Self::SubmitWorkflowSignal(_) => KIND_WORKFLOW_SIGNAL_SUBMIT,
            Self::ReconcileWorkflowSignal(_) => KIND_WORKFLOW_SIGNAL_RECONCILE,
        }
    }
}

/// A request that could not be decoded, with whatever correlation data
/// could still be recovered so the response can be addressed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodeFailure {
    /// The request id, if the frame was JSON with a string `requestId`.
    pub request_id: Option<String>,
    /// The request kind, if the frame was JSON with a string `kind`.
    pub kind: Option<String>,
    /// Version axis selected at the stage where decoding failed.
    pub response_version: ResponseVersion,
    /// Why decoding failed.
    pub error: ProtocolError,
}

impl DecodeFailure {
    /// Stable error code retained for callers that only need the rejection.
    #[must_use]
    pub fn code(&self) -> &aizign_core::ShortErrorCode {
        self.error.code()
    }
}

impl std::fmt::Display for DecodeFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for DecodeFailure {}

/// Source-qualified version axis for one response envelope.
///
/// The numeric values are both `1` today, but the variants must remain
/// distinct so an operation error cannot silently fall back to the bootstrap
/// version when the operation Protocol advances.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResponseVersion {
    /// Stable envelope used before an operation version has been accepted.
    Bootstrap(u32),
    /// The accepted version of a registered or future operation axis.
    AcceptedOperation(u32),
}

impl ResponseVersion {
    /// Current bootstrap response axis.
    #[must_use]
    pub const fn bootstrap() -> Self {
        Self::Bootstrap(BOOTSTRAP_ENVELOPE_VERSION)
    }

    /// Current operation response axis.
    #[must_use]
    pub const fn operation() -> Self {
        Self::AcceptedOperation(PROTOCOL_VERSION)
    }

    /// Numeric value written to the wire.
    #[must_use]
    pub const fn wire(self) -> u32 {
        match self {
            Self::Bootstrap(version) | Self::AcceptedOperation(version) => version,
        }
    }
}

/// A response to be written as one line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    /// Bootstrap or accepted-operation source of the wire version.
    pub version: ResponseVersion,
    /// The request id being answered; `None` only when it was unrecoverable.
    pub request_id: Option<String>,
    /// The request kind being answered; `None` only when it was unrecoverable.
    pub kind: Option<String>,
    /// Outcome.
    pub body: ResponseBody,
}

/// Success payloads and errors.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResponseBody {
    /// `hello` succeeded.
    Hello(HelloInfo),
    /// `workflow.signal.submit` was accepted or recognized as a duplicate.
    WorkflowSignal(SignalResult),
    /// `workflow.signal.reconcile` completed against a committed snapshot.
    WorkflowSignalReconciliation(ReconciliationResult),
    /// Any request failed; the code explains why.
    Error(ProtocolError),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RequestEnvelope {
    protocol: String,
    version: u32,
    request_id: String,
    kind: String,
    /// Always an object at the envelope level; each kind closes it further.
    payload: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ResponseEnvelope {
    protocol: String,
    version: u32,
    /// Present on every response (possibly `null`), never omitted.
    #[serde(deserialize_with = "required_nullable")]
    request_id: Option<String>,
    /// Present on every response (possibly `null`), never omitted.
    #[serde(deserialize_with = "required_nullable")]
    kind: Option<String>,
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    payload: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<ErrorDto>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ErrorDto {
    code: String,
    message: String,
}

/// `Option<T>` fields are implicitly optional in serde; this makes the key
/// mandatory while still accepting `null`.
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REQUEST_ID_LEN
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn parse_version_token(token: Option<&String>) -> Option<u32> {
    let token = token?;
    if token.starts_with('-') {
        return None;
    }
    token.parse().ok()
}

/// Correlation data recovered by the lenient first pass.
struct Recovered {
    request_id: Option<String>,
    kind: Option<String>,
    response_version: ResponseVersion,
    typed_text: String,
    payload_integer_out_of_range: bool,
    payload_exceeds_typed_depth: bool,
}

impl Recovered {
    fn fail(&self, error: ProtocolError) -> DecodeFailure {
        DecodeFailure {
            request_id: self.request_id.clone(),
            kind: self.kind.clone(),
            response_version: self.response_version,
            error,
        }
    }
}

/// Lenient first pass: checks size, protocol name, and the version axis chosen
/// by the recovered kind. Exact `hello` uses the bootstrap axis; every other
/// syntactically valid kind uses the operation axis before registry lookup.
fn probe(frame: &[u8]) -> Result<Recovered, DecodeFailure> {
    let unaddressed = |error: ProtocolError| DecodeFailure {
        request_id: None,
        kind: None,
        response_version: ResponseVersion::bootstrap(),
        error,
    };
    if frame.len() > MAX_REQUEST_BYTES {
        return Err(unaddressed(ProtocolError::from_valid_code(
            codes::REQUEST_TOO_LARGE,
            format!(
                "request is {} bytes; at most {MAX_REQUEST_BYTES} allowed",
                frame.len()
            ),
        )));
    }
    let text = std::str::from_utf8(frame).map_err(|error| {
        unaddressed(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            error.to_string(),
        ))
    })?;
    if text.starts_with('\u{feff}') {
        return Err(unaddressed(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            "UTF-8 BOM is not allowed before a JSON frame",
        )));
    }
    let scan = scan_json_tokens(text);
    if let Some(message) = scan.syntax_error {
        return Err(unaddressed(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            message,
        )));
    }
    if !scan.top_level_object {
        return Err(unaddressed(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            "frame must be a JSON object",
        )));
    }
    let mut recovered = Recovered {
        request_id: scan
            .top_level_strings
            .get("requestId")
            .map(String::as_str)
            .filter(|value| valid_request_id(value))
            .map(str::to_owned),
        kind: scan.top_level_strings.get("kind").cloned(),
        response_version: ResponseVersion::bootstrap(),
        typed_text: scan.typed_text.clone(),
        payload_integer_out_of_range: scan.payload_integer_out_of_range,
        payload_exceeds_typed_depth: scan.payload_exceeds_typed_depth,
    };

    if let Some(failure) = scan.failure {
        let code = if failure.kind == FailureKind::NoncanonicalNumber && failure.in_payload {
            codes::INVALID_PAYLOAD
        } else {
            codes::INVALID_ENVELOPE
        };
        return Err(recovered.fail(ProtocolError::from_valid_code(code, failure.message)));
    }

    if scan.top_level_strings.get("protocol").map(String::as_str) != Some(PROTOCOL_NAME) {
        return Err(recovered.fail(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            format!("protocol must be \"{PROTOCOL_NAME}\""),
        )));
    }
    let Some(version) = parse_version_token(scan.top_level_numbers.get("version")) else {
        return Err(recovered.fail(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            format!("version must be an integer between 0 and {}", u32::MAX),
        )));
    };

    let Some(kind) = recovered.kind.as_deref() else {
        // A non-string or missing kind cannot select an operation-version
        // axis. The strict envelope pass reports the bootstrap-v1 shape
        // failure instead of inventing an operation compatibility result.
        return Ok(recovered);
    };
    let accepted = if kind == KIND_HELLO {
        BOOTSTRAP_ENVELOPE_VERSION
    } else {
        PROTOCOL_VERSION
    };
    if version == accepted {
        if kind != KIND_HELLO {
            recovered.response_version = ResponseVersion::AcceptedOperation(accepted);
        }
        Ok(recovered)
    } else {
        Err(recovered.fail(ProtocolError::from_valid_code(
            codes::PROTOCOL_VERSION_UNSUPPORTED,
            format!("protocol version {version} is not supported; this axis speaks {accepted}"),
        )))
    }
}

/// Decodes one request frame.
pub fn decode_request(frame: &[u8]) -> Result<Request, DecodeFailure> {
    let recovered = probe(frame)?;
    let fail = |error: ProtocolError| recovered.fail(error);

    if recovered.payload_exceeds_typed_depth {
        return Err(fail(ProtocolError::from_valid_code(
            codes::INVALID_PAYLOAD,
            "payload does not match the bounded Protocol v1 shape",
        )));
    }

    let envelope: RequestEnvelope =
        serde_json::from_str(&recovered.typed_text).map_err(|error| {
            fail(ProtocolError::from_valid_code(
                codes::INVALID_ENVELOPE,
                error.to_string(),
            ))
        })?;
    if !valid_request_id(&envelope.request_id) {
        return Err(fail(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            format!(
                "requestId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{{0,{}}}$",
                MAX_REQUEST_ID_LEN - 1
            ),
        )));
    }
    debug_assert_eq!(
        envelope.version,
        if envelope.kind == KIND_HELLO {
            BOOTSTRAP_ENVELOPE_VERSION
        } else {
            PROTOCOL_VERSION
        }
    );

    let kind = match envelope.kind.as_str() {
        KIND_HELLO => {
            if !envelope.payload.is_empty() {
                return Err(fail(ProtocolError::from_valid_code(
                    codes::INVALID_PAYLOAD,
                    "hello takes an empty object payload",
                )));
            }
            RequestKind::Hello
        }
        KIND_WORKFLOW_SIGNAL_SUBMIT => {
            if recovered.payload_integer_out_of_range {
                return Err(fail(ProtocolError::from_valid_code(
                    codes::INVALID_PAYLOAD,
                    "payload integer is outside the unsigned 32-bit range",
                )));
            }
            RequestKind::SubmitWorkflowSignal(Box::new(
                workflow_signal::decode_submit(serde_json::Value::Object(envelope.payload))
                    .map_err(fail)?,
            ))
        }
        KIND_WORKFLOW_SIGNAL_RECONCILE => {
            if recovered.payload_integer_out_of_range {
                return Err(fail(ProtocolError::from_valid_code(
                    codes::INVALID_PAYLOAD,
                    "payload integer is outside the unsigned 32-bit range",
                )));
            }
            RequestKind::ReconcileWorkflowSignal(Box::new(
                workflow_signal::decode_reconcile(serde_json::Value::Object(envelope.payload))
                    .map_err(fail)?,
            ))
        }
        other => {
            return Err(fail(ProtocolError::from_valid_code(
                codes::UNKNOWN_KIND,
                format!("kind \"{other}\" is not registered"),
            )));
        }
    };

    Ok(Request {
        request_id: envelope.request_id,
        kind,
    })
}

/// Encodes a request as one line (no trailing newline).
///
/// # Errors
///
/// Returns `REQUEST_TOO_LARGE` rather than producing a frame above
/// `MAX_REQUEST_BYTES`.
pub fn encode_request(request: &Request) -> Result<String, ProtocolError> {
    if !valid_request_id(&request.request_id) {
        return Err(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            "requestId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        ));
    }
    let payload = match &request.kind {
        RequestKind::Hello => serde_json::Map::new(),
        RequestKind::SubmitWorkflowSignal(command) => match workflow_signal::encode_submit(command)
        {
            serde_json::Value::Object(map) => map,
            _ => unreachable!("submit payloads encode as objects"),
        },
        RequestKind::ReconcileWorkflowSignal(signal) => {
            match workflow_signal::encode_reconcile(signal) {
                serde_json::Value::Object(map) => map,
                _ => unreachable!("reconciliation payloads encode as objects"),
            }
        }
    };
    let envelope = RequestEnvelope {
        protocol: PROTOCOL_NAME.to_owned(),
        version: if matches!(request.kind, RequestKind::Hello) {
            BOOTSTRAP_ENVELOPE_VERSION
        } else {
            PROTOCOL_VERSION
        },
        request_id: request.request_id.clone(),
        kind: request.kind.name().to_owned(),
        payload,
    };
    let frame = serde_json::to_string(&envelope).expect("envelopes serialize without error");
    finish_request_frame(frame)
}

fn finish_request_frame(frame: String) -> Result<String, ProtocolError> {
    if frame.len() > MAX_REQUEST_BYTES {
        return Err(ProtocolError::from_valid_code(
            codes::REQUEST_TOO_LARGE,
            format!(
                "request is {} bytes; at most {MAX_REQUEST_BYTES} allowed",
                frame.len()
            ),
        ));
    }
    Ok(frame)
}

/// Encodes a response as one line (no trailing newline). The output never
/// contains a raw newline: `serde_json` escapes control characters.
///
/// # Errors
///
/// Returns `INVALID_ENVELOPE` rather than producing a frame above
/// `MAX_FRAME_BYTES`.
pub fn encode_response(response: &Response) -> Result<String, ProtocolError> {
    if response
        .request_id
        .as_deref()
        .is_some_and(|request_id| !valid_request_id(request_id))
    {
        return Err(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            "requestId must be null or match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        ));
    }
    if response.version.wire() == 0 {
        return Err(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            "response version must be at least 1",
        ));
    }
    match (&response.version, response.kind.as_deref(), &response.body) {
        (ResponseVersion::Bootstrap(version), Some(KIND_HELLO), ResponseBody::Hello(info))
            if *version == BOOTSTRAP_ENVELOPE_VERSION =>
        {
            info.validate().map_err(|message| {
                ProtocolError::from_valid_code(codes::INVALID_PAYLOAD, message)
            })?;
        }
        (
            ResponseVersion::AcceptedOperation(_),
            Some(KIND_WORKFLOW_SIGNAL_SUBMIT),
            ResponseBody::WorkflowSignal(_),
        )
        | (
            ResponseVersion::AcceptedOperation(_),
            Some(KIND_WORKFLOW_SIGNAL_RECONCILE),
            ResponseBody::WorkflowSignalReconciliation(_),
        )
        | (
            ResponseVersion::Bootstrap(BOOTSTRAP_ENVELOPE_VERSION)
            | ResponseVersion::AcceptedOperation(_),
            _,
            ResponseBody::Error(_),
        ) => {}
        _ => {
            return Err(ProtocolError::from_valid_code(
                codes::INVALID_ENVELOPE,
                "response kind, body, and selected version context are inconsistent",
            ));
        }
    }
    let (ok, payload, error) = match &response.body {
        ResponseBody::Hello(info) => (
            true,
            Some(serde_json::to_value(info).expect("DTOs serialize")),
            None,
        ),
        ResponseBody::WorkflowSignal(result) => {
            (true, Some(workflow_signal::encode_result(result)), None)
        }
        ResponseBody::WorkflowSignalReconciliation(result) => (
            true,
            Some(workflow_signal::encode_reconciliation_result(result)),
            None,
        ),
        ResponseBody::Error(error) => (
            false,
            None,
            Some(ErrorDto {
                code: error.code().to_string(),
                message: error.message().to_owned(),
            }),
        ),
    };
    let envelope = ResponseEnvelope {
        protocol: PROTOCOL_NAME.to_owned(),
        version: response.version.wire(),
        request_id: response.request_id.clone(),
        kind: response.kind.clone(),
        ok,
        payload,
        error,
    };
    let frame = serde_json::to_string(&envelope).expect("envelopes serialize without error");
    if frame.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            format!(
                "response is {} bytes; at most {MAX_FRAME_BYTES} allowed",
                frame.len()
            ),
        ));
    }
    Ok(frame)
}

/// Decodes one response frame. Used by adapters, testkits, and fixtures.
pub fn decode_response(frame: &[u8]) -> Result<Response, DecodeFailure> {
    decode_response_for(frame, None)
}

/// Decodes one response while retaining the caller's request-stage version.
///
/// The context matters for bounded operation errors whose correlation kind was
/// intentionally replaced with `null`: their wire version is still the
/// accepted operation version even though the kind can no longer prove that
/// from response bytes alone. The numeric value inside the supplied version is
/// the exact value expected for that request stage. Pre-operation error codes
/// remain on the current bootstrap version.
// Keeping the normative gate order linear makes accidental typed decoding or
// version selection before the raw-token pass visible in review.
#[allow(clippy::too_many_lines)]
pub fn decode_response_for(
    frame: &[u8],
    request_stage: Option<ResponseVersion>,
) -> Result<Response, DecodeFailure> {
    let initial_version = request_stage.unwrap_or_else(ResponseVersion::bootstrap);
    let unaddressed = |error: ProtocolError| DecodeFailure {
        request_id: None,
        kind: None,
        response_version: initial_version,
        error,
    };
    if frame.len() > MAX_FRAME_BYTES {
        return Err(unaddressed(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            format!(
                "response is {} bytes; at most {MAX_FRAME_BYTES} allowed",
                frame.len()
            ),
        )));
    }
    let text = std::str::from_utf8(frame).map_err(|error| {
        unaddressed(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            error.to_string(),
        ))
    })?;
    if text.starts_with('\u{feff}') {
        return Err(unaddressed(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            "UTF-8 BOM is not allowed before a JSON frame",
        )));
    }
    let scan = scan_json_tokens(text);
    if let Some(message) = scan.syntax_error {
        return Err(unaddressed(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            message,
        )));
    }
    if !scan.top_level_object {
        return Err(unaddressed(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            "frame must be a JSON object",
        )));
    }
    let recovered = Recovered {
        request_id: scan
            .top_level_strings
            .get("requestId")
            .map(String::as_str)
            .filter(|value| valid_request_id(value))
            .map(str::to_owned),
        kind: scan.top_level_strings.get("kind").cloned(),
        response_version: initial_version,
        typed_text: scan.typed_text.clone(),
        payload_integer_out_of_range: scan.payload_integer_out_of_range,
        payload_exceeds_typed_depth: scan.payload_exceeds_typed_depth,
    };
    let ok = scan.top_level_booleans.get("ok").copied();
    let error_code = scan.error_code.as_deref();
    let expected =
        expected_response_version(recovered.kind.as_deref(), ok, error_code, request_stage);
    let fail = |error: ProtocolError| DecodeFailure {
        request_id: recovered.request_id.clone(),
        kind: recovered.kind.clone(),
        response_version: expected,
        error,
    };
    if let Some(failure) = scan.failure {
        let code = if failure.kind == FailureKind::NoncanonicalNumber && failure.in_payload {
            codes::INVALID_PAYLOAD
        } else {
            codes::INVALID_ENVELOPE
        };
        return Err(fail(ProtocolError::from_valid_code(code, failure.message)));
    }
    if scan.top_level_strings.get("protocol").map(String::as_str) != Some(PROTOCOL_NAME) {
        return Err(fail(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            format!("protocol must be \"{PROTOCOL_NAME}\""),
        )));
    }
    let Some(wire_version) = parse_version_token(scan.top_level_numbers.get("version")) else {
        return Err(fail(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            format!("version must be an integer between 0 and {}", u32::MAX),
        )));
    };
    if wire_version != expected.wire() {
        let axis = match expected {
            ResponseVersion::Bootstrap(_) => "bootstrap",
            ResponseVersion::AcceptedOperation(_) => "accepted-operation",
        };
        return Err(fail(ProtocolError::from_valid_code(
            codes::PROTOCOL_VERSION_UNSUPPORTED,
            format!(
                "{axis} response version must be {}; got {wire_version}",
                expected.wire()
            ),
        )));
    }
    if recovered.payload_exceeds_typed_depth {
        return Err(fail(ProtocolError::from_valid_code(
            codes::INVALID_PAYLOAD,
            "payload does not match the bounded Protocol v1 shape",
        )));
    }

    let envelope: ResponseEnvelope =
        serde_json::from_str(&recovered.typed_text).map_err(|error| {
            fail(ProtocolError::from_valid_code(
                codes::INVALID_ENVELOPE,
                error.to_string(),
            ))
        })?;
    if envelope.protocol != PROTOCOL_NAME {
        return Err(fail(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            format!("protocol must be \"{PROTOCOL_NAME}\""),
        )));
    }
    if envelope
        .request_id
        .as_deref()
        .is_some_and(|id| !valid_request_id(id))
    {
        return Err(fail(ProtocolError::from_valid_code(
            codes::INVALID_ENVELOPE,
            "requestId must be null or match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        )));
    }
    let body = match (envelope.ok, envelope.payload, envelope.error) {
        (true, Some(payload), None) => match envelope.kind.as_deref() {
            Some(KIND_HELLO) => {
                if recovered.payload_integer_out_of_range {
                    return Err(fail(ProtocolError::from_valid_code(
                        codes::INVALID_PAYLOAD,
                        "payload integer is outside the unsigned 32-bit range",
                    )));
                }
                let info: crate::HelloInfo = serde_json::from_value(payload).map_err(|error| {
                    fail(ProtocolError::from_valid_code(
                        codes::INVALID_PAYLOAD,
                        error.to_string(),
                    ))
                })?;
                info.validate().map_err(|message| {
                    fail(ProtocolError::from_valid_code(
                        codes::INVALID_PAYLOAD,
                        message,
                    ))
                })?;
                ResponseBody::Hello(info)
            }
            Some(KIND_WORKFLOW_SIGNAL_SUBMIT) => {
                if recovered.payload_integer_out_of_range {
                    return Err(fail(ProtocolError::from_valid_code(
                        codes::INVALID_PAYLOAD,
                        "payload integer is outside the unsigned 32-bit range",
                    )));
                }
                ResponseBody::WorkflowSignal(workflow_signal::decode_result(payload).map_err(fail)?)
            }
            Some(KIND_WORKFLOW_SIGNAL_RECONCILE) => {
                if recovered.payload_integer_out_of_range {
                    return Err(fail(ProtocolError::from_valid_code(
                        codes::INVALID_PAYLOAD,
                        "payload integer is outside the unsigned 32-bit range",
                    )));
                }
                ResponseBody::WorkflowSignalReconciliation(
                    workflow_signal::decode_reconciliation_result(payload).map_err(fail)?,
                )
            }
            Some(other) => {
                return Err(fail(ProtocolError::from_valid_code(
                    codes::UNKNOWN_KIND,
                    format!("kind \"{other}\" is not registered"),
                )));
            }
            None => {
                return Err(fail(ProtocolError::from_valid_code(
                    codes::INVALID_ENVELOPE,
                    "successful responses must name their kind",
                )));
            }
        },
        (false, None, Some(error)) => {
            if aizign_core::ShortErrorCode::new(&error.code).is_err() {
                return Err(fail(ProtocolError::from_valid_code(
                    codes::INVALID_ENVELOPE,
                    "error.code must match ^[A-Z][A-Z0-9_]{0,63}$",
                )));
            }
            ResponseBody::Error(ProtocolError::from_valid_code(&error.code, error.message))
        }
        _ => {
            return Err(fail(ProtocolError::from_valid_code(
                codes::INVALID_ENVELOPE,
                "ok responses carry exactly payload; error responses carry exactly error",
            )));
        }
    };
    Ok(Response {
        version: expected,
        request_id: envelope.request_id,
        kind: envelope.kind,
        body,
    })
}

fn expected_response_version(
    kind: Option<&str>,
    ok: Option<bool>,
    error_code: Option<&str>,
    request_stage: Option<ResponseVersion>,
) -> ResponseVersion {
    let inferred_request_stage = || match request_stage {
        Some(stage) => stage,
        None if kind.is_some_and(|kind| kind != KIND_HELLO) => ResponseVersion::operation(),
        None => ResponseVersion::bootstrap(),
    };
    if ok == Some(true) {
        match kind {
            Some(KIND_HELLO) => {
                ResponseVersion::Bootstrap(expected_bootstrap_version(request_stage))
            }
            Some(_) => {
                ResponseVersion::AcceptedOperation(expected_operation_version(request_stage))
            }
            None => inferred_request_stage(),
        }
    } else if ok == Some(false) && error_code.is_some_and(is_unconditionally_bootstrap_error_code) {
        ResponseVersion::Bootstrap(expected_bootstrap_version(request_stage))
    } else {
        inferred_request_stage()
    }
}

fn expected_bootstrap_version(request_stage: Option<ResponseVersion>) -> u32 {
    match request_stage {
        Some(ResponseVersion::Bootstrap(version)) => version,
        Some(ResponseVersion::AcceptedOperation(_)) | None => BOOTSTRAP_ENVELOPE_VERSION,
    }
}

fn expected_operation_version(request_stage: Option<ResponseVersion>) -> u32 {
    match request_stage {
        Some(ResponseVersion::AcceptedOperation(version)) => version,
        Some(ResponseVersion::Bootstrap(_)) | None => PROTOCOL_VERSION,
    }
}

fn is_unconditionally_bootstrap_error_code(code: &str) -> bool {
    matches!(
        code,
        codes::REQUEST_TOO_LARGE | codes::PROTOCOL_VERSION_UNSUPPORTED | codes::HANDLER_TIMEOUT
    )
}

#[cfg(test)]
mod encoder_bound_tests {
    use super::{MAX_REQUEST_BYTES, finish_request_frame};
    use crate::codes;

    #[test]
    fn final_request_guard_accepts_the_bound_and_rejects_the_next_byte() {
        assert_eq!(
            finish_request_frame("x".repeat(MAX_REQUEST_BYTES))
                .unwrap()
                .len(),
            MAX_REQUEST_BYTES
        );
        assert_eq!(
            finish_request_frame("x".repeat(MAX_REQUEST_BYTES + 1))
                .unwrap_err()
                .code()
                .as_str(),
            codes::REQUEST_TOO_LARGE
        );
    }
}
