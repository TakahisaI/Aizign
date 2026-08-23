//! The binary end to end: one frame in, one frame out, state on disk.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use aizu_core::workflow::Command as CoreCommand;
use aizu_protocol::{
    Disposition, MAX_REQUEST_BYTES, Request, RequestKind, ResponseBody, codes, decode_response,
    encode_request,
};
use aizu_store_jsonl::{JOURNAL_FILE_NAME, JsonlJournal};
use aizu_testkit::{TempDir, signals};

fn aizu() -> Command {
    Command::new(env!("CARGO_BIN_EXE_aizu"))
}

fn run_handle(state: &Path, frame: &str) -> Output {
    let mut child = aizu()
        .arg("handle")
        .arg("--state")
        .arg(state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn aizu");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(frame.as_bytes())
        .unwrap();
    child.wait_with_output().expect("wait for aizu")
}

fn one_frame(output: &Output) -> aizu_protocol::Response {
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
    let output = aizu().arg("hello").output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let response = one_frame(&output);
    let ResponseBody::Hello(info) = response.body else {
        panic!("expected hello")
    };
    assert_eq!(info.protocol_version, 1);
    assert_eq!(info.journal_schema_version, 1);
    assert_eq!(info.capabilities, ["workflow.signal.submit"]);
    assert_eq!(info.package.name, "aizu");
}

#[test]
fn hello_request_frame_is_answered_with_its_request_id() {
    let dir = TempDir::new();
    let output = run_handle(
        &dir.state(),
        r#"{"protocol":"aizu","version":1,"requestId":"req-h","kind":"hello","payload":{}}"#,
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
        r#"{"protocol":"aizu"}"#
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
        let output = aizu().args(&args).stdin(Stdio::null()).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
    }
    let output = aizu()
        .args(["handle", "--state="])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
}
