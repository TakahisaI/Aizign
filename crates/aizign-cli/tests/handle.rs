//! The binary end to end: one frame in, one frame out, state on disk.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use aizign_core::workflow::Command as CoreCommand;
use aizign_protocol::{
    Disposition, MAX_REQUEST_BYTES, Request, RequestKind, ResponseBody, codes, decode_response,
    encode_request,
};
use aizign_store_jsonl::{JOURNAL_FILE_NAME, JsonlJournal};
use aizign_testkit::{TempDir, signals};

fn aizign() -> Command {
    Command::new(env!("CARGO_BIN_EXE_aizign"))
}

fn run_handle(state: &Path, frame: &str) -> Output {
    let mut child = aizign()
        .arg("handle")
        .arg("--state")
        .arg(state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn aizign");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(frame.as_bytes())
        .unwrap();
    child.wait_with_output().expect("wait for aizign")
}

fn one_frame(output: &Output) -> aizign_protocol::Response {
    let stdout = String::from_utf8(output.stdout.clone()).unwrap();
    assert_eq!(
        stdout.matches('\n').count(),
        1,
        "stdout must be exactly one frame: {stdout:?}"
    );
    assert!(stdout.ends_with('\n'));
    decode_response(stdout.trim_end().as_bytes()).expect("stdout is a protocol frame")
}

fn submit_frame(event_id: &str, request_id: &str) -> String {
    let command = CoreCommand::SubmitSignal {
        signal: signals::implementation_ready(event_id),
        expected: signals::expected(),
    };
    let mut frame = encode_request(&Request {
        request_id: request_id.to_owned(),
        kind: RequestKind::SubmitWorkflowSignal(Box::new(command)),
    });
    frame.push('\n');
    frame
}

#[test]
fn hello_subcommand_reports_capabilities_without_state() {
    let output = aizign().arg("hello").output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let response = one_frame(&output);
    let ResponseBody::Hello(info) = response.body else {
        panic!("expected hello")
    };
    assert_eq!(info.protocol_version, 1);
    assert_eq!(info.journal_schema_version, 1);
    assert_eq!(info.capabilities, ["workflow.signal.submit"]);
    assert_eq!(info.package.name, "aizign");
}

#[test]
fn hello_request_frame_is_answered_with_its_request_id() {
    let dir = TempDir::new();
    let output = run_handle(
        &dir.state(),
        r#"{"protocol":"aizign","version":1,"requestId":"req-h","kind":"hello","payload":{}}"#,
    );
    assert_eq!(output.status.code(), Some(0));
    let response = one_frame(&output);
    assert_eq!(response.request_id.as_deref(), Some("req-h"));
    assert!(matches!(response.body, ResponseBody::Hello(_)));
    assert!(
        !dir.state().exists(),
        "hello never touches the state directory"
    );
}

#[test]
fn accepted_then_duplicate_across_processes_and_conflict() {
    let dir = TempDir::new();
    let state = dir.state();

    let output = run_handle(&state, &submit_frame("evt-1", "req-1"));
    assert_eq!(output.status.code(), Some(0));
    let ResponseBody::WorkflowSignal(result) = one_frame(&output).body else {
        panic!("accepted")
    };
    assert_eq!(result.disposition, Disposition::Accepted);
    assert!(state.join(JOURNAL_FILE_NAME).is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(state.join(JOURNAL_FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // A fresh process rebuilds state from the journal alone.
    let output = run_handle(&state, &submit_frame("evt-1", "req-2"));
    let ResponseBody::WorkflowSignal(result) = one_frame(&output).body else {
        panic!("duplicate")
    };
    assert_eq!(result.disposition, Disposition::Duplicate);

    let conflicting = CoreCommand::SubmitSignal {
        signal: signals::blocked("evt-1", "X"),
        expected: signals::expected(),
    };
    let mut frame = encode_request(&Request {
        request_id: "req-3".to_owned(),
        kind: RequestKind::SubmitWorkflowSignal(Box::new(conflicting)),
    });
    frame.push('\n');
    let output = run_handle(&state, &frame);
    assert_eq!(
        output.status.code(),
        Some(0),
        "rejections are still responses"
    );
    let response = one_frame(&output);
    let ResponseBody::Error(error) = response.body else {
        panic!("conflict")
    };
    assert_eq!(error.code().as_str(), "EVENT_CONFLICT");
    assert_eq!(response.request_id.as_deref(), Some("req-3"));
    assert_eq!(response.kind.as_deref(), Some("workflow.signal.submit"));
}

#[test]
fn stderr_carries_identity_and_codes_but_no_contents() {
    let dir = TempDir::new();
    let output = run_handle(&dir.state(), &submit_frame("evt-log", "req-log"));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("requestId=req-log"), "{stderr}");
    assert!(stderr.contains("outcome=accepted"), "{stderr}");
    for secret in ["evt-log", "rev-a", "artifactRevision", "wf-test"] {
        assert!(
            !stderr.contains(secret),
            "stderr must not echo payload content: {stderr}"
        );
    }
}

#[test]
fn malformed_and_oversized_frames_still_get_one_response() {
    let dir = TempDir::new();
    let output = run_handle(&dir.state(), "not json\n");
    assert_eq!(output.status.code(), Some(0));
    let ResponseBody::Error(error) = one_frame(&output).body else {
        panic!("error")
    };
    assert_eq!(error.code().as_str(), codes::INVALID_ENVELOPE);

    let huge = format!(
        "{}{}\n",
        " ".repeat(MAX_REQUEST_BYTES),
        r#"{"protocol":"aizign"}"#
    );
    let output = run_handle(&dir.state(), &huge);
    let ResponseBody::Error(error) = one_frame(&output).body else {
        panic!("error")
    };
    assert_eq!(error.code().as_str(), codes::REQUEST_TOO_LARGE);

    let output = run_handle(&dir.state(), "");
    let ResponseBody::Error(error) = one_frame(&output).body else {
        panic!("error")
    };
    assert_eq!(error.code().as_str(), codes::INVALID_ENVELOPE);
}

#[test]
fn stdin_must_carry_exactly_one_frame() {
    let dir = TempDir::new();
    let two = format!(
        "{}{}",
        submit_frame("evt-a", "req-a"),
        submit_frame("evt-b", "req-b")
    );
    let ResponseBody::Error(error) = one_frame(&run_handle(&dir.state(), &two)).body else {
        panic!("error")
    };
    assert_eq!(error.code().as_str(), codes::INVALID_ENVELOPE);
    assert!(
        !dir.state().join(JOURNAL_FILE_NAME).exists(),
        "nothing is appended for a rejected stdin"
    );

    let trailing = format!("{}trailing prose\n", submit_frame("evt-a", "req-a"));
    let ResponseBody::Error(error) = one_frame(&run_handle(&dir.state(), &trailing)).body else {
        panic!("error")
    };
    assert_eq!(error.code().as_str(), codes::INVALID_ENVELOPE);

    // Trailing whitespace after the newline is fine.
    let whitespace = format!("{}\n  \n", submit_frame("evt-a", "req-ws"));
    assert!(matches!(
        one_frame(&run_handle(&dir.state(), &whitespace)).body,
        ResponseBody::WorkflowSignal(_)
    ));
}

/// Pads a frame with trailing spaces (inside the frame, before its newline)
/// to exactly `MAX_REQUEST_BYTES`, the largest size the protocol accepts.
fn frame_at_size_bound(event_id: &str, request_id: &str) -> String {
    let frame = submit_frame(event_id, request_id);
    let body = frame.trim_end_matches('\n');
    assert!(body.len() < MAX_REQUEST_BYTES);
    format!("{body}{}\n", " ".repeat(MAX_REQUEST_BYTES - body.len()))
}

#[test]
fn trailing_content_is_still_rejected_at_the_frame_size_bound() {
    // Regression for the fail-open boundary (#34): with the frame at exactly
    // MAX_REQUEST_BYTES, a bounded reader saw only one byte after the newline,
    // so one whitespace byte could hide a second frame beyond the bound.
    let dir = TempDir::new();
    let hidden = format!(
        "{} {}",
        frame_at_size_bound("evt-bound", "req-bound"),
        submit_frame("evt-hidden", "req-hidden")
    );
    let ResponseBody::Error(error) = one_frame(&run_handle(&dir.state(), &hidden)).body else {
        panic!("error")
    };
    assert_eq!(error.code().as_str(), codes::INVALID_ENVELOPE);
    assert!(
        !dir.state().join(JOURNAL_FILE_NAME).exists(),
        "nothing is appended for a rejected stdin"
    );

    let garbage = format!(
        "{}   trailing prose\n",
        frame_at_size_bound("evt-bound", "req-bound")
    );
    let ResponseBody::Error(error) = one_frame(&run_handle(&dir.state(), &garbage)).body else {
        panic!("error")
    };
    assert_eq!(error.code().as_str(), codes::INVALID_ENVELOPE);

    // A frame at exactly the bound is still valid on its own.
    let exact = frame_at_size_bound("evt-bound", "req-bound");
    assert!(matches!(
        one_frame(&run_handle(&dir.state(), &exact)).body,
        ResponseBody::WorkflowSignal(_)
    ));
}

#[test]
fn a_stdin_that_never_closes_ends_as_handler_timeout_not_a_hang() {
    // The one-frame check scans to EOF, so the whole request (read included)
    // must sit inside the watchdog: a caller holding stdin open after the
    // trailing whitespace gets a bounded HANDLER_TIMEOUT, and the process
    // exits without appending (#34).
    let dir = TempDir::new();
    let mut child = aizign()
        .arg("handle")
        .arg("--state")
        .arg(dir.state())
        .env("AIZIGN_HANDLE_TIMEOUT_MS", "300")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn aizign");
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(format!("{}  ", submit_frame("evt-held", "req-held")).as_bytes())
        .unwrap();
    stdin.flush().unwrap();

    // Keep stdin open; the watchdog must answer anyway, within bounded time.
    let started = std::time::Instant::now();
    let output = child.wait_with_output().expect("wait for aizign");
    drop(stdin);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the process must exit on the watchdog, not wait for EOF"
    );
    let ResponseBody::Error(error) = one_frame(&output).body else {
        panic!("error")
    };
    assert_eq!(error.code().as_str(), codes::HANDLER_TIMEOUT);
    assert!(
        !dir.state().join(JOURNAL_FILE_NAME).exists(),
        "nothing is appended while stdin is still open"
    );
}

#[test]
fn journal_problems_are_reported_as_journal_codes() {
    let dir = TempDir::new();
    let state = dir.state();
    let held = JsonlJournal::open(&state).unwrap();
    let output = run_handle(&state, &submit_frame("evt-1", "req-1"));
    let ResponseBody::Error(error) = one_frame(&output).body else {
        panic!("locked")
    };
    assert_eq!(error.code().as_str(), "JOURNAL_LOCKED");
    drop(held);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o755)).unwrap();
        let output = run_handle(&state, &submit_frame("evt-1", "req-1"));
        let ResponseBody::Error(error) = one_frame(&output).body else {
            panic!("unavailable")
        };
        assert_eq!(error.code().as_str(), "JOURNAL_UNAVAILABLE");
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}

#[test]
fn usage_errors_write_no_frame() {
    for args in [
        vec!["handle"],
        vec!["handle", "--state"],
        vec!["handle", "--state", ""],
        vec!["bogus"],
    ] {
        let output = aizign().args(&args).stdin(Stdio::null()).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
    }
    let output = aizign()
        .args(["handle", "--state="])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
}
