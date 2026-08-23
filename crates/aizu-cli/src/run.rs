//! Wiring: frames in and out, the system clock, the JSONL journal, and a
//! watchdog that bounds processing time.

use std::io::{self, BufRead as _, Read as _, Write as _};
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aizu_core::BoundedTimestamp;
use aizu_engine::{Clock, ClockError, HandleError, SignalOutcome, handle_workflow_signal};
use aizu_protocol::{
    CAPABILITY_WORKFLOW_SIGNAL_SUBMIT, Disposition, HelloInfo, MAX_REQUEST_BYTES, PROTOCOL_VERSION,
    PackageInfo, ProtocolError, Request, RequestKind, Response, ResponseBody, SignalResult, codes,
    decode_request, encode_response,
};
use aizu_store_jsonl::{JOURNAL_SCHEMA_VERSION, JsonlJournal};

use crate::exit;

/// Upper bound on processing one request. Past it, the response reports
/// `HANDLER_TIMEOUT` and the process exits; any append in flight is unknown.
const HANDLER_TIMEOUT: Duration = Duration::from_secs(10);

struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Result<BoundedTimestamp, ClockError> {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ClockError::OutOfRange)?
            .as_secs();
        BoundedTimestamp::from_unix_seconds(seconds).map_err(|_| ClockError::OutOfRange)
    }
}

fn hello_info() -> HelloInfo {
    HelloInfo {
        protocol_version: PROTOCOL_VERSION,
        journal_schema_version: u32::try_from(JOURNAL_SCHEMA_VERSION).unwrap_or(u32::MAX),
        capabilities: vec![CAPABILITY_WORKFLOW_SIGNAL_SUBMIT.to_owned()],
        package: PackageInfo {
            name: env!("CARGO_PKG_NAME").trim_end_matches("-cli").to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        },
    }
}

/// `aizu hello`: the handshake without a request frame.
pub(crate) fn hello() -> u8 {
    let response = Response {
        request_id: None,
        kind: Some(aizu_protocol::KIND_HELLO.to_owned()),
        body: ResponseBody::Hello(hello_info()),
    };
    write_frame(&response)
}

/// `aizu handle --state <dir>`: one request in, one response out.
pub(crate) fn handle(state: &Path) -> u8 {
    let frame = match read_stdin() {
        Ok(Stdin::Frame(frame)) => frame,
        Ok(Stdin::Extra) => {
            log("decode", None, None, codes::INVALID_ENVELOPE);
            return write_frame(&Response {
                request_id: None,
                kind: None,
                body: ResponseBody::Error(ProtocolError::new(
                    codes::INVALID_ENVELOPE,
                    "stdin must carry exactly one frame",
                )),
            });
        }
        Err(error) => {
            eprintln!("aizu: cannot read request frame: {error}");
            return exit::IO;
        }
    };

    let state = state.to_path_buf();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let response = respond(&frame, &state);
        // The receiver is gone only if the watchdog already answered.
        let _ = sender.send(response);
    });

    let response = receiver.recv_timeout(HANDLER_TIMEOUT).unwrap_or_else(|_| {
        eprintln!(
            "aizu: handler exceeded {}s; any append outcome is unknown",
            HANDLER_TIMEOUT.as_secs()
        );
        Response {
            request_id: None,
            kind: None,
            body: ResponseBody::Error(ProtocolError::new(
                codes::HANDLER_TIMEOUT,
                format!(
                    "processing exceeded {}s; the journal outcome is unknown",
                    HANDLER_TIMEOUT.as_secs()
                ),
            )),
        }
    });
    write_frame(&response)
}

/// What stdin carried: exactly one frame, or something that is not one.
enum Stdin {
    Frame(Vec<u8>),
    /// A second frame or trailing content followed the first newline.
    Extra,
}

/// Reads stdin: the first line, bounded by the protocol limit (plus one byte
/// to detect overflow), then the rest of the stream to EOF. Exactly one frame
/// is allowed; anything but whitespace after the first newline is not a
/// request. The trailing scan is unbounded on purpose: bounding it would let
/// a second frame hide beyond the bound when the first frame is exactly at
/// the size limit, and a stdin that never closes is already covered by the
/// handler watchdog.
fn read_stdin() -> io::Result<Stdin> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut frame = Vec::new();
    (&mut reader)
        .take(MAX_REQUEST_BYTES as u64 + 2)
        .read_until(b'\n', &mut frame)?;
    if frame.last() == Some(&b'\n') {
        frame.pop();
        let mut rest = [0_u8; 4096];
        loop {
            let read = reader.read(&mut rest)?;
            if read == 0 {
                break;
            }
            if rest[..read].iter().any(|byte| !byte.is_ascii_whitespace()) {
                return Ok(Stdin::Extra);
            }
        }
    }
    Ok(Stdin::Frame(frame))
}

fn respond(frame: &[u8], state: &Path) -> Response {
    let request = match decode_request(frame) {
        Ok(request) => request,
        Err(failure) => {
            log(
                "decode",
                failure.request_id.as_deref(),
                failure.kind.as_deref(),
                failure.error.code().as_str(),
            );
            return Response {
                request_id: failure.request_id,
                kind: failure.kind,
                body: ResponseBody::Error(failure.error),
            };
        }
    };
    let Request { request_id, kind } = request;
    let kind_name = kind.name().to_owned();
    let body = match kind {
        RequestKind::Hello => ResponseBody::Hello(hello_info()),
        RequestKind::SubmitWorkflowSignal(command) => match JsonlJournal::open(state) {
            Err(error) => ResponseBody::Error(ProtocolError::new(error.code(), error.to_string())),
            Ok(mut journal) => match handle_workflow_signal(&mut journal, &SystemClock, *command) {
                Ok(SignalOutcome::Accepted { entry }) => {
                    let aizu_core::workflow::WorkflowEvent::SignalAccepted { signal } = entry.event;
                    ResponseBody::WorkflowSignal(SignalResult {
                        disposition: Disposition::Accepted,
                        event_id: signal.event_id().clone(),
                    })
                }
                Ok(SignalOutcome::Duplicate { event_id }) => {
                    ResponseBody::WorkflowSignal(SignalResult {
                        disposition: Disposition::Duplicate,
                        event_id,
                    })
                }
                Err(error) => ResponseBody::Error(handle_error(&error)),
            },
        },
    };
    let outcome = match &body {
        ResponseBody::Hello(_) => "ok",
        ResponseBody::WorkflowSignal(result) => match result.disposition {
            Disposition::Accepted => "accepted",
            Disposition::Duplicate => "duplicate",
        },
        ResponseBody::Error(error) => error.code().as_str(),
    };
    log("handle", Some(&request_id), Some(&kind_name), outcome);
    Response {
        request_id: Some(request_id),
        kind: Some(kind_name),
        body,
    }
}

fn handle_error(error: &HandleError) -> ProtocolError {
    match error {
        HandleError::Rejected(rejection) => ProtocolError::from(rejection.clone()),
        other => ProtocolError::new(other.code(), other.to_string()),
    }
}

/// One structured line on stderr: identity and codes only, never contents.
fn log(stage: &str, request_id: Option<&str>, kind: Option<&str>, outcome: &str) {
    eprintln!(
        "aizu: stage={stage} requestId={} kind={} outcome={outcome}",
        request_id.unwrap_or("-"),
        kind.unwrap_or("-")
    );
}

fn write_frame(response: &Response) -> u8 {
    let mut line = encode_response(response);
    line.push('\n');
    let mut stdout = io::stdout().lock();
    match stdout
        .write_all(line.as_bytes())
        .and_then(|()| stdout.flush())
    {
        Ok(()) => exit::OK,
        Err(error) => {
            eprintln!("aizu: cannot write response frame: {error}");
            exit::IO
        }
    }
}
