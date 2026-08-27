//! Wiring: frames in and out, the system clock, the JSONL journal, and a
//! watchdog that bounds processing time.

use std::io::{self, Read as _, Write as _};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aizign_core::BoundedTimestamp;
use aizign_core::recovery::SignalReconciliation;
use aizign_engine::{
    Clock, ClockError, HandleError, ReconcileError, SignalOutcome, handle_workflow_signal,
    handle_workflow_signal_observed, reconcile_workflow_signal, reconcile_workflow_signal_observed,
};
use aizign_protocol::{
    CAPABILITY_WORKFLOW_SIGNAL_RECONCILE, CAPABILITY_WORKFLOW_SIGNAL_SUBMIT, Disposition,
    HelloInfo, MAX_REQUEST_BYTES, PROTOCOL_VERSION, PackageInfo, ProtocolError,
    ReconciliationDisposition, ReconciliationResult, Request, RequestKind, Response, ResponseBody,
    SignalResult, codes, decode_request, encode_response, is_current_fixed_error_code,
};
use aizign_store_jsonl::{
    JOURNAL_SCHEMA_VERSION, JsonlJournal, JsonlJournalReader, STORE_PLATFORM_SUPPORTED,
};

use crate::exit;
use crate::timing::{
    EngineTimingObserver, HandlerTiming, StoreTimingObserver, enabled as timing_enabled,
    milliseconds,
};

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
    let timing_enabled = timing_enabled();
    let handler_started = timing_enabled.then(Instant::now);
    let timeout = handler_timeout();
    let state = state.to_path_buf();
    let dispatch_started = Arc::new(AtomicBool::new(false));
    let worker_dispatch_started = Arc::clone(&dispatch_started);
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut timing = timing_enabled.then(HandlerTiming::default);
        let read_started = timing_enabled.then(Instant::now);
        let stdin = read_stdin();
        if let (Some(timing), Some(started)) = (timing.as_mut(), read_started) {
            timing.request_read_ms = Some(milliseconds(started.elapsed()));
        }
        let outcome = stdin.map(|stdin| match stdin {
            Stdin::Frame(frame) => {
                respond(&frame, &state, timing.as_mut(), &worker_dispatch_started)
            }
            Stdin::Invalid => framing_error(
                codes::INVALID_ENVELOPE,
                "stdin must be one non-empty body followed by LF and immediate EOF",
                timing.as_mut(),
            ),
            Stdin::TooLarge => framing_error(
                codes::REQUEST_TOO_LARGE,
                format!("request body exceeds {MAX_REQUEST_BYTES} bytes"),
                timing.as_mut(),
            ),
        });
        // The receiver is gone only if the watchdog already answered.
        let _ = sender.send(outcome.map(|response| WorkerResponse { response, timing }));
    });

    let mut handled = match receiver.recv_timeout(timeout) {
        Ok(Ok(measured)) => measured,
        Ok(Err(error)) => {
            eprintln!("aizign: cannot read request frame: {error}");
            return exit::IO;
        }
        Err(_) => timeout_response(
            timeout,
            dispatch_started.load(Ordering::Acquire),
            timing_enabled,
        ),
    };
    match (handled.timing.as_mut(), handler_started) {
        (Some(timing), Some(started)) => write_measured_frame(&handled.response, timing, started),
        _ => write_frame(&handled.response),
    }
}

fn framing_error(
    code: &str,
    message: impl Into<String>,
    timing: Option<&mut HandlerTiming>,
) -> Response {
    log("framing", None, None, code);
    if let Some(timing) = timing {
        timing.operation_kind = Some("unknown");
        timing.outcome = Some("rejected");
        timing.error_code = Some(code.to_owned());
    }
    Response {
        request_id: None,
        kind: None,
        body: ResponseBody::Error(ProtocolError::new(code, message)),
    }
}

fn timeout_response(timeout: Duration, dispatched: bool, timing_enabled: bool) -> WorkerResponse {
    let elapsed = timeout.as_millis();
    let (message, outcome) = if dispatched {
        eprintln!(
            "aizign: processing exceeded {elapsed}ms after dispatch; an effect may have occurred"
        );
        (
            format!("processing exceeded {elapsed}ms after dispatch; the outcome is unknown"),
            "unknown",
        )
    } else {
        eprintln!(
            "aizign: request framing exceeded {elapsed}ms before dispatch; no state effect occurred"
        );
        (
            format!("request framing exceeded {elapsed}ms before dispatch"),
            "rejected",
        )
    };
    WorkerResponse {
        response: Response {
            request_id: None,
            kind: None,
            body: ResponseBody::Error(ProtocolError::new(codes::HANDLER_TIMEOUT, message)),
        },
        timing: timing_enabled.then(|| HandlerTiming {
            operation_kind: Some("unknown"),
            outcome: Some(outcome),
            error_code: Some(codes::HANDLER_TIMEOUT.to_owned()),
            ..HandlerTiming::default()
        }),
    }
}

struct WorkerResponse {
    response: Response,
    timing: Option<HandlerTiming>,
}

/// What stdin carried: exactly one frame, or something that is not one.
enum Stdin {
    Frame(Vec<u8>),
    /// Empty, unterminated, CRLF-terminated, or followed by any byte.
    Invalid,
    /// More than the body bound appeared before the first LF.
    TooLarge,
}

/// Reads the complete process-profile stream. Dispatch is impossible until
/// body, LF, and immediate EOF have all been established. The 65,537th body
/// byte fails immediately, while a peer holding an in-bound stream open stays
/// in this function until the watchdog emits a pre-dispatch timeout.
fn read_stdin() -> io::Result<Stdin> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut frame = Vec::new();
    let mut newline_seen = false;
    let mut chunk = [0_u8; 4096];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            return Ok(if newline_seen {
                Stdin::Frame(frame)
            } else {
                Stdin::Invalid
            });
        }
        for &byte in &chunk[..read] {
            if newline_seen {
                return Ok(Stdin::Invalid);
            }
            if byte == b'\n' {
                if frame.is_empty() || frame.last() == Some(&b'\r') {
                    return Ok(Stdin::Invalid);
                }
                newline_seen = true;
            } else if frame.len() == MAX_REQUEST_BYTES {
                return Ok(Stdin::TooLarge);
            } else {
                frame.push(byte);
            }
        }
    }
}

fn respond(
    frame: &[u8],
    state: &Path,
    mut timing: Option<&mut HandlerTiming>,
    dispatch_started: &AtomicBool,
) -> Response {
    let decode_started = timing.is_some().then(Instant::now);
    let request = match decode_request(frame) {
        Ok(request) => {
            if let (Some(timing), Some(started)) = (timing.as_deref_mut(), decode_started) {
                timing.decode_ms = Some(milliseconds(started.elapsed()));
            }
            request
        }
        Err(failure) => {
            let safe_kind = observed_operation_kind(failure.kind.as_deref());
            if let Some(timing) = timing.as_deref_mut() {
                if let Some(started) = decode_started {
                    timing.decode_ms = Some(milliseconds(started.elapsed()));
                }
                timing.operation_kind = Some(safe_kind);
                timing.outcome = Some("rejected");
                timing.error_code = Some(failure.error.code().as_str().to_owned());
            }
            log(
                "decode",
                failure.request_id.as_deref(),
                Some(safe_kind),
                failure.error.code().as_str(),
            );
            let mut response = Response {
                request_id: failure.request_id,
                kind: failure.kind,
                body: ResponseBody::Error(failure.error),
            };
            if encode_response(&response).is_err() {
                let code = match &response.body {
                    ResponseBody::Error(error) => error.code().as_str().to_owned(),
                    _ => unreachable!("decode failures are errors"),
                };
                response.kind = None;
                response.body = ResponseBody::Error(ProtocolError::new(
                    &code,
                    "request rejected; recovered correlation was not safe to echo",
                ));
            }
            return response;
        }
    };
    let Request { request_id, kind } = request;
    let operation_kind = kind.name();
    let kind_name = operation_kind.to_owned();
    if let Some(timing) = timing.as_deref_mut() {
        timing.operation_kind = Some(operation_kind);
    }
    dispatch_started.store(true, Ordering::Release);
    let body = execute_request(kind, &kind_name, state, timing.as_deref_mut());
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
    if let Some(timing) = timing {
        record_semantic_outcome(&kind_name, &body, timing);
    }
    log("handle", Some(&request_id), Some(&kind_name), outcome);
    Response {
        request_id: Some(request_id),
        kind: Some(kind_name),
        body,
    }
}

fn execute_request(
    kind: RequestKind,
    kind_name: &str,
    state: &Path,
    timing: Option<&mut HandlerTiming>,
) -> ResponseBody {
    match kind {
        RequestKind::Hello => ResponseBody::Hello(hello_info()),
        RequestKind::SubmitWorkflowSignal(_) | RequestKind::ReconcileWorkflowSignal(_)
            if !STORE_PLATFORM_SUPPORTED =>
        {
            ResponseBody::Error(store_capability_unsupported(kind_name))
        }
        RequestKind::SubmitWorkflowSignal(command) => submit_response(*command, state, timing),
        RequestKind::ReconcileWorkflowSignal(signal) => reconcile_response(&signal, state, timing),
    }
}

fn submit_response(
    command: aizign_core::workflow::Command,
    state: &Path,
    timing: Option<&mut HandlerTiming>,
) -> ResponseBody {
    let handled = if let Some(timing) = timing {
        let (engine_timing, store_timing) = (&mut timing.engine, &mut timing.store);
        let mut store_observer = StoreTimingObserver::new(store_timing);
        let mut journal = match JsonlJournal::open_observed(state, &mut store_observer) {
            Ok(journal) => journal,
            Err(error) => {
                return ResponseBody::Error(ProtocolError::new(error.code(), error.to_string()));
            }
        };
        let mut engine_observer = EngineTimingObserver::new(engine_timing);
        handle_workflow_signal_observed(&mut journal, &SystemClock, command, &mut engine_observer)
    } else {
        let mut journal = match JsonlJournal::open(state) {
            Ok(journal) => journal,
            Err(error) => {
                return ResponseBody::Error(ProtocolError::new(error.code(), error.to_string()));
            }
        };
        handle_workflow_signal(&mut journal, &SystemClock, command)
    };
    match handled {
        Ok(SignalOutcome::Accepted { entry }) => {
            let aizign_core::workflow::WorkflowEvent::SignalAccepted { signal } = entry.event;
            ResponseBody::WorkflowSignal(SignalResult {
                disposition: Disposition::Accepted,
                event_id: signal.event_id().clone(),
            })
        }
        Ok(SignalOutcome::Duplicate { event_id }) => ResponseBody::WorkflowSignal(SignalResult {
            disposition: Disposition::Duplicate,
            event_id,
        }),
        Err(error) => ResponseBody::Error(handle_error(&error)),
    }
}

fn reconcile_response(
    signal: &aizign_core::workflow::WorkflowSignal,
    state: &Path,
    timing: Option<&mut HandlerTiming>,
) -> ResponseBody {
    let reconciled = if let Some(timing) = timing {
        let (engine_timing, store_timing) = (&mut timing.engine, &mut timing.store);
        let mut store_observer = StoreTimingObserver::new(store_timing);
        let mut journal = match JsonlJournalReader::open_observed(state, &mut store_observer) {
            Ok(journal) => journal,
            Err(error) => {
                return ResponseBody::Error(ProtocolError::new(error.code(), error.to_string()));
            }
        };
        let mut engine_observer = EngineTimingObserver::new(engine_timing);
        reconcile_workflow_signal_observed(&mut journal, signal, &mut engine_observer)
    } else {
        let mut journal = match JsonlJournalReader::open(state) {
            Ok(journal) => journal,
            Err(error) => {
                return ResponseBody::Error(ProtocolError::new(error.code(), error.to_string()));
            }
        };
        reconcile_workflow_signal(&mut journal, signal)
    };
    match reconciled {
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
    }
}

fn record_semantic_outcome(kind: &str, body: &ResponseBody, timing: &mut HandlerTiming) {
    match body {
        ResponseBody::Hello(_) => timing.outcome = Some("ok"),
        ResponseBody::WorkflowSignal(result) => {
            timing.outcome = Some(match result.disposition {
                Disposition::Accepted => "accepted",
                Disposition::Duplicate => "duplicate",
            });
        }
        ResponseBody::WorkflowSignalReconciliation(result) => {
            timing.outcome = Some(match result.disposition {
                ReconciliationDisposition::Accepted => "accepted",
                ReconciliationDisposition::Conflict => "conflict",
                ReconciliationDisposition::Absent => "absent",
            });
        }
        ResponseBody::Error(error) => {
            let code = error.code().as_str();
            let is_fixed = is_current_fixed_error_code(code);
            timing.error_code = is_fixed.then(|| code.to_owned());
            timing.outcome = Some(
                if !is_fixed
                    || kind == aizign_protocol::KIND_WORKFLOW_SIGNAL_RECONCILE
                    || matches!(
                        code,
                        "INTERNAL" | "HANDLER_TIMEOUT" | "JOURNAL_OUTCOME_UNKNOWN"
                    )
                {
                    "unknown"
                } else if kind == aizign_protocol::KIND_HELLO {
                    "error"
                } else if code == "EVENT_CONFLICT" {
                    "conflict"
                } else {
                    "rejected"
                },
            );
        }
    }
}

fn observed_operation_kind(kind: Option<&str>) -> &'static str {
    match kind {
        Some(aizign_protocol::KIND_HELLO) => aizign_protocol::KIND_HELLO,
        Some(aizign_protocol::KIND_WORKFLOW_SIGNAL_SUBMIT) => {
            aizign_protocol::KIND_WORKFLOW_SIGNAL_SUBMIT
        }
        Some(aizign_protocol::KIND_WORKFLOW_SIGNAL_RECONCILE) => {
            aizign_protocol::KIND_WORKFLOW_SIGNAL_RECONCILE
        }
        _ => "unknown",
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

fn write_measured_frame(
    response: &Response,
    timing: &mut HandlerTiming,
    handler_started: Instant,
) -> u8 {
    let encode_started = Instant::now();
    let encoded = encode_response(response);
    timing.response_encode_ms = Some(milliseconds(encode_started.elapsed()));
    let mut line = match encoded {
        Ok(line) => line,
        Err(error) => {
            timing.handler_total_ms = Some(milliseconds(handler_started.elapsed()));
            timing.emit();
            eprintln!("aizign: cannot encode response frame: {error}");
            return exit::IO;
        }
    };
    line.push('\n');

    let write_started = Instant::now();
    let mut stdout = io::stdout().lock();
    let written = stdout
        .write_all(line.as_bytes())
        .and_then(|()| stdout.flush());
    timing.response_write_ms = Some(milliseconds(write_started.elapsed()));
    timing.handler_total_ms = Some(milliseconds(handler_started.elapsed()));
    timing.emit();

    match written {
        Ok(()) => exit::OK,
        Err(error) => {
            eprintln!("aizign: cannot write response frame: {error}");
            exit::IO
        }
    }
}

fn write_frame(response: &Response) -> u8 {
    let mut line = match encode_response(response) {
        Ok(line) => line,
        Err(error) => {
            eprintln!("aizign: cannot encode response frame: {error}");
            return exit::IO;
        }
    };
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

#[cfg(test)]
mod classification_tests {
    use aizign_core::EventId;
    use aizign_protocol::{
        Disposition, ProtocolError, ReconciliationDisposition, ReconciliationResult, ResponseBody,
        SignalResult,
    };
    use serde_json::Value;

    use super::{hello_info, record_semantic_outcome};
    use crate::timing::HandlerTiming;

    fn event_id() -> EventId {
        EventId::new("evt-classification").expect("event id")
    }

    fn response_body(row: &Value) -> ResponseBody {
        let response_case = &row["responseCase"];
        if response_case["kind"] == "error" {
            let code = row["reportedCode"]["value"]
                .as_str()
                .unwrap_or("FUTURE_OUTCOME_UNKNOWN");
            return ResponseBody::Error(ProtocolError::new(code, "classification fixture"));
        }

        match row["operation"].as_str().expect("operation") {
            "hello" => ResponseBody::Hello(hello_info()),
            "workflow.signal.submit" => ResponseBody::WorkflowSignal(SignalResult {
                disposition: match response_case["disposition"].as_str() {
                    Some("accepted") => Disposition::Accepted,
                    Some("duplicate") => Disposition::Duplicate,
                    other => panic!("unexpected submit disposition {other:?}"),
                },
                event_id: event_id(),
            }),
            "workflow.signal.reconcile" => {
                ResponseBody::WorkflowSignalReconciliation(ReconciliationResult {
                    disposition: match response_case["disposition"].as_str() {
                        Some("accepted") => ReconciliationDisposition::Accepted,
                        Some("conflict") => ReconciliationDisposition::Conflict,
                        Some("absent") => ReconciliationDisposition::Absent,
                        other => panic!("unexpected reconciliation disposition {other:?}"),
                    },
                    event_id: event_id(),
                })
            }
            other => panic!("unexpected operation {other}"),
        }
    }

    #[test]
    fn child_observations_follow_every_classification_corpus_row() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../spec/classification/current-operations.json"
        ))
        .expect("classification corpus");
        let rows = corpus["rows"].as_array().expect("rows");
        assert_eq!(rows.len(), 78);

        for row in rows {
            let body = response_body(row);
            let mut timing = HandlerTiming::default();
            let operation = row["operation"].as_str().expect("operation");
            record_semantic_outcome(operation, &body, &mut timing);

            assert_eq!(
                timing.outcome,
                Some(
                    row["childObservation"]["value"]
                        .as_str()
                        .expect("child outcome")
                ),
                "{} / {:?}",
                operation,
                row["reportedCode"]["value"]
            );
            let expected_code = row["timingCodeDisclosure"]
                .as_bool()
                .expect("timingCodeDisclosure")
                .then(|| row["reportedCode"]["value"].as_str().map(ToOwned::to_owned))
                .flatten();
            assert_eq!(timing.error_code, expected_code);
            assert_eq!(
                row["reportedCode"]["kind"] == "none",
                expected_code.is_none() && row["responseCase"]["kind"] == "success"
            );
        }
    }
}
