//! Wiring: frames in and out, the system clock, the JSONL journal, and a
//! watchdog that bounds processing time.

use std::io::{self, BufRead as _, Read as _, Write as _};
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aizign_core::BoundedTimestamp;
use aizign_core::recovery::SignalReconciliation;
use aizign_engine::{
    Clock, ClockError, HandleError, ReconcileError, SignalOutcome, handle_workflow_signal,
    reconcile_workflow_signal,
};
use aizign_protocol::{
    CAPABILITY_WORKFLOW_SIGNAL_RECONCILE, CAPABILITY_WORKFLOW_SIGNAL_SUBMIT, Disposition,
    HelloInfo, MAX_REQUEST_BYTES, PROTOCOL_VERSION, PackageInfo, ProtocolError,
    ReconciliationDisposition, ReconciliationResult, Request, RequestKind, Response, ResponseBody,
    SignalResult, codes, decode_request, encode_response,
};
use aizign_store_jsonl::{
    JOURNAL_SCHEMA_VERSION, JsonlJournal, JsonlJournalReader, STORE_PLATFORM_SUPPORTED,
};

use crate::exit;

/// Upper bound on reading and processing one request. Past it, the response
/// reports `HANDLER_TIMEOUT` and the process exits; any append in flight is
/// unknown.
const HANDLER_TIMEOUT: Duration = Duration::from_secs(10);

/// The watchdog bound: `HANDLER_TIMEOUT`, or `AIZIGN_HANDLE_TIMEOUT_MS`
/// (1..=600000) when set — a test hook. Adapters spawn `aizign` with only
/// `PATH` in the environment, so a harness cannot reach this knob.
fn handler_timeout() -> Duration {
    std::env::var("AIZIGN_HANDLE_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|ms| (1..=600_000).contains(ms))
        .map_or(HANDLER_TIMEOUT, Duration::from_millis)
}

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
    let capabilities = if STORE_PLATFORM_SUPPORTED {
        vec![
            CAPABILITY_WORKFLOW_SIGNAL_SUBMIT.to_owned(),
            CAPABILITY_WORKFLOW_SIGNAL_RECONCILE.to_owned(),
        ]
    } else {
        Vec::new()
    };
    HelloInfo {
        protocol_version: PROTOCOL_VERSION,
        journal_schema_version: u32::try_from(JOURNAL_SCHEMA_VERSION).unwrap_or(u32::MAX),
        capabilities,
        package: PackageInfo {
            name: env!("CARGO_PKG_NAME").trim_end_matches("-cli").to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        },
    }
}

/// `aizign hello`: the handshake without a request frame.
pub(crate) fn hello() -> u8 {
    let response = Response {
        request_id: None,
        kind: Some(aizign_protocol::KIND_HELLO.to_owned()),
        body: ResponseBody::Hello(hello_info()),
    };
    write_frame(&response)
}

/// `aizign handle --state <dir>`: one request in, one response out.
///
/// The watchdog bounds the whole request — reading stdin included, because
/// the one-frame check scans to EOF and a caller that never closes stdin
/// must not hold the process open (#34).
pub(crate) fn handle(state: &Path) -> u8 {
    let timeout = handler_timeout();
    let state = state.to_path_buf();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let outcome = read_stdin().map(|stdin| match stdin {
            Stdin::Frame(frame) => respond(&frame, &state),
            Stdin::Extra => {
                log("decode", None, None, codes::INVALID_ENVELOPE);
                Response {
                    request_id: None,
                    kind: None,
                    body: ResponseBody::Error(ProtocolError::new(
                        codes::INVALID_ENVELOPE,
                        "stdin must carry exactly one frame",
                    )),
                }
            }
        });
        // The receiver is gone only if the watchdog already answered.
        let _ = sender.send(outcome);
    });

    let response = match receiver.recv_timeout(timeout) {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            eprintln!("aizign: cannot read request frame: {error}");
            return exit::IO;
        }
        Err(_) => {
            eprintln!(
                "aizign: request exceeded {}ms; any append outcome is unknown",
                timeout.as_millis()
            );
            Response {
                request_id: None,
                kind: None,
                body: ResponseBody::Error(ProtocolError::new(
                    codes::HANDLER_TIMEOUT,
                    format!(
                        "processing exceeded {}ms; the journal outcome is unknown",
                        timeout.as_millis()
                    ),
                )),
            }
        }
    };
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
/// the size limit. This function runs inside the watchdog thread, so a stdin
/// that never reaches EOF ends as `HANDLER_TIMEOUT`, not as a hang.
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
        RequestKind::SubmitWorkflowSignal(_) | RequestKind::ReconcileWorkflowSignal(_)
            if !STORE_PLATFORM_SUPPORTED =>
        {
            ResponseBody::Error(store_capability_unsupported(&kind_name))
        }
        RequestKind::SubmitWorkflowSignal(command) => match JsonlJournal::open(state) {
            Err(error) => ResponseBody::Error(ProtocolError::new(error.code(), error.to_string())),
            Ok(mut journal) => match handle_workflow_signal(&mut journal, &SystemClock, *command) {
                Ok(SignalOutcome::Accepted { entry }) => {
                    let aizign_core::workflow::WorkflowEvent::SignalAccepted { signal } =
                        entry.event;
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
        RequestKind::ReconcileWorkflowSignal(signal) => match JsonlJournalReader::open(state) {
            Err(error) => ResponseBody::Error(ProtocolError::new(error.code(), error.to_string())),
            Ok(mut journal) => match reconcile_workflow_signal(&mut journal, &signal) {
                Ok(disposition) => {
                    let disposition = match disposition {
                        SignalReconciliation::Accepted => ReconciliationDisposition::Accepted,
                        SignalReconciliation::Conflict => ReconciliationDisposition::Conflict,
                        SignalReconciliation::Absent => ReconciliationDisposition::Absent,
                    };
                    ResponseBody::WorkflowSignalReconciliation(ReconciliationResult {
                        disposition,
                        event_id: signal.event_id().clone(),
                    })
                }
                Err(error) => ResponseBody::Error(reconcile_error(&error)),
            },
        },
    };
    let outcome = match &body {
        ResponseBody::Hello(_) => "ok",
        ResponseBody::WorkflowSignal(result) => match result.disposition {
            Disposition::Accepted => "accepted",
            Disposition::Duplicate => "duplicate",
        },
        ResponseBody::WorkflowSignalReconciliation(result) => match result.disposition {
            ReconciliationDisposition::Accepted => "accepted",
            ReconciliationDisposition::Conflict => "conflict",
            ReconciliationDisposition::Absent => "absent",
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

fn store_capability_unsupported(kind: &str) -> ProtocolError {
    ProtocolError::new(
        codes::CAPABILITY_UNSUPPORTED,
        format!("{kind} is unavailable on this unverified storage platform"),
    )
}

fn handle_error(error: &HandleError) -> ProtocolError {
    match error {
        HandleError::Rejected(rejection) => ProtocolError::from(rejection.clone()),
        other => ProtocolError::new(other.code(), other.to_string()),
    }
}

fn reconcile_error(error: &ReconcileError) -> ProtocolError {
    ProtocolError::new(error.code(), error.to_string())
}

/// One structured line on stderr: identity and codes only, never contents.
fn log(stage: &str, request_id: Option<&str>, kind: Option<&str>, outcome: &str) {
    eprintln!(
        "aizign: stage={stage} requestId={} kind={} outcome={outcome}",
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
            eprintln!("aizign: cannot write response frame: {error}");
            exit::IO
        }
    }
}
