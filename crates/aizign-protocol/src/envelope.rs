//! Request and response envelopes: the one-line NDJSON frames that cross
//! the process boundary.

use aizign_core::workflow::{Command, WorkflowSignal};
use serde::{Deserialize, Serialize};

use crate::error::{ProtocolError, codes};
use crate::hello::HelloInfo;
use crate::json_member::has_duplicate_members;
use crate::workflow_signal::{self, ReconciliationResult, SignalResult};

/// Value of the `protocol` field.
pub const PROTOCOL_NAME: &str = "aizign";
/// The wire protocol version this crate implements.
pub const PROTOCOL_VERSION: u32 = 1;
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
    /// Why decoding failed.
    pub error: ProtocolError,
}

/// A response to be written as one line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
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

/// Lenient first pass: recovers version and correlation data without
/// rejecting unknown fields, so a newer-version frame still gets a
/// `PROTOCOL_VERSION_UNSUPPORTED` answer addressed to its request id.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    #[serde(default)]
    protocol: Option<serde_json::Value>,
    #[serde(default)]
    version: Option<serde_json::Value>,
    #[serde(default)]
    request_id: Option<serde_json::Value>,
    #[serde(default)]
    kind: Option<serde_json::Value>,
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

/// Correlation data recovered by the lenient first pass.
struct Recovered {
    request_id: Option<String>,
    kind: Option<String>,
}

impl Recovered {
    fn fail(&self, error: ProtocolError) -> DecodeFailure {
        DecodeFailure {
            request_id: self.request_id.clone(),
            kind: self.kind.clone(),
            error,
        }
    }
}

/// Lenient first pass: checks size, protocol name, and version, and
/// recovers correlation data, so that even a frame from a newer protocol
/// version gets an addressed `PROTOCOL_VERSION_UNSUPPORTED` answer.
fn probe(frame: &[u8]) -> Result<Recovered, DecodeFailure> {
    let unaddressed = |error: ProtocolError| DecodeFailure {
        request_id: None,
        kind: None,
        error,
    };
    if frame.len() > MAX_REQUEST_BYTES {
        return Err(unaddressed(ProtocolError::new(
            codes::REQUEST_TOO_LARGE,
            format!(
                "request is {} bytes; at most {MAX_REQUEST_BYTES} allowed",
                frame.len()
            ),
        )));
    }
    if has_duplicate_members(frame) {
        // The frame repeats a member, so it never reaches interpretation.
        // Correlation data is recovered from the folded view — the last
        // spelling of each field wins, exactly what the TypeScript
        // decoder's `JSON.parse` produces before any check runs. The
        // typed `Probe` rejects duplicates itself, so the folded view is
        // read through an untyped map instead.
        let folded: serde_json::Value = serde_json::from_slice(frame).map_err(|error| {
            unaddressed(ProtocolError::new(
                codes::INVALID_ENVELOPE,
                error.to_string(),
            ))
        })?;
        let recovered = Recovered {
            request_id: folded
                .get("requestId")
                .and_then(serde_json::Value::as_str)
                .filter(|value| valid_request_id(value))
                .map(str::to_owned),
            kind: folded
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
        };
        return Err(recovered.fail(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            "frame repeats a JSON member; repeated members are not part of the contract",
        )));
    }
    let probe: Probe = serde_json::from_slice(frame).map_err(|error| {
        unaddressed(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            error.to_string(),
        ))
    })?;
    let recovered = Recovered {
        request_id: probe
            .request_id
            .as_ref()
            .and_then(serde_json::Value::as_str)
            .filter(|value| valid_request_id(value))
            .map(str::to_owned),
        kind: probe
            .kind
            .as_ref()
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    };

    if probe.protocol.as_ref().and_then(serde_json::Value::as_str) != Some(PROTOCOL_NAME) {
        return Err(recovered.fail(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            format!("protocol must be \"{PROTOCOL_NAME}\""),
        )));
    }
    match probe.version.as_ref().and_then(serde_json::Value::as_u64) {
        // `PROTOCOL_VERSION` is a `u32`, so versions beyond `u32::MAX` are
        // out of the protocol's integer range: `INVALID_ENVELOPE`, exactly
        // like the TypeScript decoder, which parses JSON numbers as `f64`
        // and applies the same bound. Only then can a version mismatch be
        // reported as `PROTOCOL_VERSION_UNSUPPORTED`.
        Some(version) if version > u64::from(u32::MAX) => Err(recovered.fail(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            format!("version must be an integer between 0 and {}", u32::MAX),
        ))),
        Some(version) if version == u64::from(PROTOCOL_VERSION) => Ok(recovered),
        Some(version) => Err(recovered.fail(ProtocolError::new(
            codes::PROTOCOL_VERSION_UNSUPPORTED,
            format!(
                "protocol version {version} is not supported; this binary speaks {PROTOCOL_VERSION}"
            ),
        ))),
        None => Err(recovered.fail(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            "version must be an unsigned integer",
        ))),
    }
}

/// Decodes one request frame.
pub fn decode_request(frame: &[u8]) -> Result<Request, DecodeFailure> {
    let recovered = probe(frame)?;
    let fail = |error: ProtocolError| recovered.fail(error);

    let envelope: RequestEnvelope = serde_json::from_slice(frame).map_err(|error| {
        fail(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            error.to_string(),
        ))
    })?;
    if !valid_request_id(&envelope.request_id) {
        return Err(fail(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            format!(
                "requestId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{{0,{}}}$",
                MAX_REQUEST_ID_LEN - 1
            ),
        )));
    }
    debug_assert_eq!(u64::from(envelope.version), u64::from(PROTOCOL_VERSION));

    let kind = match envelope.kind.as_str() {
        KIND_HELLO => {
            if !envelope.payload.is_empty() {
                return Err(fail(ProtocolError::new(
                    codes::INVALID_PAYLOAD,
                    "hello takes an empty object payload",
                )));
            }
            RequestKind::Hello
        }
        KIND_WORKFLOW_SIGNAL_SUBMIT => RequestKind::SubmitWorkflowSignal(Box::new(
            workflow_signal::decode_submit(serde_json::Value::Object(envelope.payload))
                .map_err(fail)?,
        )),
        KIND_WORKFLOW_SIGNAL_RECONCILE => RequestKind::ReconcileWorkflowSignal(Box::new(
            workflow_signal::decode_reconcile(serde_json::Value::Object(envelope.payload))
                .map_err(fail)?,
        )),
        other => {
            return Err(fail(ProtocolError::new(
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
#[must_use]
pub fn encode_request(request: &Request) -> String {
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
        version: PROTOCOL_VERSION,
        request_id: request.request_id.clone(),
        kind: request.kind.name().to_owned(),
        payload,
    };
    serde_json::to_string(&envelope).expect("envelopes serialize without error")
}

/// Encodes a response as one line (no trailing newline). The output never
/// contains a raw newline: `serde_json` escapes control characters.
///
/// # Errors
///
/// Returns `INVALID_ENVELOPE` rather than producing a frame above
/// `MAX_FRAME_BYTES`.
pub fn encode_response(response: &Response) -> Result<String, ProtocolError> {
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
        version: PROTOCOL_VERSION,
        request_id: response.request_id.clone(),
        kind: response.kind.clone(),
        ok,
        payload,
        error,
    };
    let frame = serde_json::to_string(&envelope).expect("envelopes serialize without error");
    if frame.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::new(
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
pub fn decode_response(frame: &[u8]) -> Result<Response, ProtocolError> {
    if frame.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            format!(
                "response is {} bytes; at most {MAX_FRAME_BYTES} allowed",
                frame.len()
            ),
        ));
    }
    if has_duplicate_members(frame) {
        // Same rule as requests (see `probe`): a repeated member has no
        // single meaning, so the frame never reaches interpretation.
        return Err(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            "frame repeats a JSON member; repeated members are not part of the contract",
        ));
    }
    let envelope: ResponseEnvelope = serde_json::from_slice(frame)
        .map_err(|error| ProtocolError::new(codes::INVALID_ENVELOPE, error.to_string()))?;
    if envelope.protocol != PROTOCOL_NAME {
        return Err(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            format!("protocol must be \"{PROTOCOL_NAME}\""),
        ));
    }
    if envelope.version != PROTOCOL_VERSION {
        return Err(ProtocolError::new(
            codes::PROTOCOL_VERSION_UNSUPPORTED,
            format!(
                "protocol version {} is not supported; this binary speaks {PROTOCOL_VERSION}",
                envelope.version
            ),
        ));
    }
    if envelope
        .request_id
        .as_deref()
        .is_some_and(|id| !valid_request_id(id))
    {
        return Err(ProtocolError::new(
            codes::INVALID_ENVELOPE,
            "requestId must be null or match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        ));
    }
    let body = match (envelope.ok, envelope.payload, envelope.error) {
        (true, Some(payload), None) => match envelope.kind.as_deref() {
            Some(KIND_HELLO) => {
                let info: crate::HelloInfo = serde_json::from_value(payload).map_err(|error| {
                    ProtocolError::new(codes::INVALID_PAYLOAD, error.to_string())
                })?;
                info.validate()
                    .map_err(|message| ProtocolError::new(codes::INVALID_PAYLOAD, message))?;
                ResponseBody::Hello(info)
            }
            Some(KIND_WORKFLOW_SIGNAL_SUBMIT) => {
                ResponseBody::WorkflowSignal(workflow_signal::decode_result(payload)?)
            }
            Some(KIND_WORKFLOW_SIGNAL_RECONCILE) => ResponseBody::WorkflowSignalReconciliation(
                workflow_signal::decode_reconciliation_result(payload)?,
            ),
            Some(other) => {
                return Err(ProtocolError::new(
                    codes::UNKNOWN_KIND,
                    format!("kind \"{other}\" is not registered"),
                ));
            }
            None => {
                return Err(ProtocolError::new(
                    codes::INVALID_ENVELOPE,
                    "successful responses must name their kind",
                ));
            }
        },
        (false, None, Some(error)) => {
            if aizign_core::ShortErrorCode::new(&error.code).is_err() {
                return Err(ProtocolError::new(
                    codes::INVALID_ENVELOPE,
                    "error.code must match ^[A-Z][A-Z0-9_]{0,63}$",
                ));
            }
            ResponseBody::Error(ProtocolError::new(&error.code, error.message))
        }
        _ => {
            return Err(ProtocolError::new(
                codes::INVALID_ENVELOPE,
                "ok responses carry exactly payload; error responses carry exactly error",
            ));
        }
    };
    Ok(Response {
        request_id: envelope.request_id,
        kind: envelope.kind,
        body,
    })
}
