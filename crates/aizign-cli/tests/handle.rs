//! The binary end to end: one frame in, one frame out, state on disk.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use aizign_core::workflow::Command as CoreCommand;
#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
use aizign_protocol::{Disposition, ReconciliationDisposition};
use aizign_protocol::{
    MAX_REQUEST_BYTES, Request, RequestKind, ResponseBody, codes, decode_response, encode_request,
};
use aizign_store_jsonl::JOURNAL_FILE_NAME;
#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
use aizign_store_jsonl::{COMMIT_FILE_NAME, JsonlJournal, LOCK_FILE_NAME};
use aizign_testkit::{TempDir, signals};

const PROCESS_PROFILE_CASE_IDS: &[&str] = &[
    "req-empty-eof",
    "req-empty-held",
    "req-partial-held",
    "req-max-held",
    "req-no-lf-eof",
    "req-valid",
    "req-exact-bound",
    "req-over-bound",
    "req-crlf",
    "req-max-crlf",
    "req-json-space",
    "req-post-lf-space",
    "req-post-lf-tab",
    "req-post-lf-cr",
    "req-post-lf-second-lf",
    "req-post-lf-second-frame",
    "req-eof-held",
    "hello-nonexistent-state",
    "hello-no-lf-eof",
    "hello-post-lf-byte",
    "hello-over-bound",
    "hello-held-open",
    "kind-response-unsafe",
];

#[test]
fn process_profile_case_ids_are_unique() {
    let unique: std::collections::BTreeSet<_> = PROCESS_PROFILE_CASE_IDS.iter().collect();
    assert_eq!(unique.len(), PROCESS_PROFILE_CASE_IDS.len());
}

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

fn run_handle_with_timing(state: &Path, frame: &str) -> Output {
    let mut child = aizign()
        .arg("handle")
        .arg("--state")
        .arg(state)
        .env("AIZIGN_TIMING_JSON", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn timed aizign");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(frame.as_bytes())
        .unwrap();
    child.wait_with_output().expect("wait for timed aizign")
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn run_handle_without_observing_stdout(state: &Path, frame: &str) -> std::process::ExitStatus {
    let mut child = aizign()
        .arg("handle")
        .arg("--state")
        .arg(state)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn aizign");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(frame.as_bytes())
        .unwrap();
    child.wait().expect("wait for aizign")
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn run_handle_with_umask(state: &Path, frame: &str, mask: &str) -> Output {
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg("umask \"$1\"; shift; exec \"$@\"")
        .arg("aizign-umask-test")
        .arg(mask)
        .arg(env!("CARGO_BIN_EXE_aizign"))
        .arg("handle")
        .arg("--state")
        .arg(state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn aizign under restrictive umask");
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
    let body = stdout.strip_suffix('\n').expect("one terminating LF");
    assert!(!body.contains('\n'), "no byte follows the response LF");
    decode_response(body.as_bytes()).expect("stdout is a protocol frame")
}

fn timing_metric(output: &Output) -> serde_json::Value {
    let stderr = String::from_utf8(output.stderr.clone()).unwrap();
    let encoded = stderr
        .lines()
        .find_map(|line| line.strip_prefix("aizign_timing:"))
        .unwrap_or_else(|| panic!("missing timing line: {stderr}"));
    serde_json::from_str(encoded).expect("timing is JSON")
}

fn submit_frame(event_id: &str, request_id: &str) -> String {
    let command = CoreCommand::SubmitSignal {
        signal: signals::implementation_ready(event_id),
        expected: signals::expected(),
    };
    let mut frame = encode_request(&Request {
        request_id: request_id.to_owned(),
        kind: RequestKind::SubmitWorkflowSignal(Box::new(command)),
    })
    .unwrap();
    frame.push('\n');
    frame
}

fn reconcile_frame(signal: aizign_core::workflow::WorkflowSignal, request_id: &str) -> String {
    let mut frame = encode_request(&Request {
        request_id: request_id.to_owned(),
        kind: RequestKind::ReconcileWorkflowSignal(Box::new(signal)),
    })
    .unwrap();
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
    #[cfg(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    ))]
    assert_eq!(
        info.capabilities,
        ["workflow.signal.submit", "workflow.signal.reconcile"]
    );
    #[cfg(not(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    )))]
    assert!(info.capabilities.is_empty());
    assert_eq!(info.package.name, "aizign");
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
#[test]
fn reconciliation_is_read_only_and_classifies_the_committed_snapshot() {
    let missing = TempDir::new();
    let output = run_handle(
        &missing.state(),
        &reconcile_frame(signals::implementation_ready("evt-1"), "req-missing"),
    );
    let ResponseBody::Error(error) = one_frame(&output).body else {
        panic!("missing store must be unknown")
    };
    assert_eq!(error.code().as_str(), "JOURNAL_UNAVAILABLE");
    assert!(
        !missing.state().exists(),
        "reconciliation never initializes"
    );

    let initialized = TempDir::new();
    let initialized_state = initialized.state();
    drop(JsonlJournal::open(&initialized_state).expect("durably initialize empty store"));
    let before_journal = std::fs::read(initialized_state.join(JOURNAL_FILE_NAME)).unwrap();
    let before_commit = std::fs::read(initialized_state.join(COMMIT_FILE_NAME)).unwrap();
    let ResponseBody::WorkflowSignalReconciliation(result) = one_frame(&run_handle(
        &initialized_state,
        &reconcile_frame(
            signals::implementation_ready("evt-pre-append"),
            "req-pre-append",
        ),
    ))
    .body
    else {
        panic!("initialized empty snapshot must establish absence")
    };
    assert_eq!(result.disposition, ReconciliationDisposition::Absent);
    assert_eq!(
        std::fs::read(initialized_state.join(JOURNAL_FILE_NAME)).unwrap(),
        before_journal
    );
    assert_eq!(
        std::fs::read(initialized_state.join(COMMIT_FILE_NAME)).unwrap(),
        before_commit
    );

    let dir = TempDir::new();
    let state = dir.state();
    one_frame(&run_handle(&state, &submit_frame("evt-1", "req-submit")));

    let response = one_frame(&run_handle(
        &state,
        &reconcile_frame(signals::implementation_ready("evt-1"), "req-accepted"),
    ));
    assert_eq!(response.request_id.as_deref(), Some("req-accepted"));
    assert_eq!(response.kind.as_deref(), Some("workflow.signal.reconcile"));
    let ResponseBody::WorkflowSignalReconciliation(result) = response.body else {
        panic!("accepted reconciliation")
    };
    assert_eq!(result.disposition, ReconciliationDisposition::Accepted);
    assert_eq!(result.event_id.as_str(), "evt-1");

    let ResponseBody::WorkflowSignalReconciliation(result) = one_frame(&run_handle(
        &state,
        &reconcile_frame(signals::blocked("evt-1", "CHANGED"), "req-conflict"),
    ))
    .body
    else {
        panic!("conflict reconciliation")
    };
    assert_eq!(result.disposition, ReconciliationDisposition::Conflict);

    let ResponseBody::WorkflowSignalReconciliation(result) = one_frame(&run_handle(
        &state,
        &reconcile_frame(signals::implementation_ready("evt-absent"), "req-absent"),
    ))
    .body
    else {
        panic!("absent reconciliation")
    };
    assert_eq!(result.disposition, ReconciliationDisposition::Absent);

    let corrupt = TempDir::new();
    let corrupt_state = corrupt.state();
    drop(JsonlJournal::open(&corrupt_state).expect("initialize corrupt test store"));
    std::fs::write(corrupt_state.join(COMMIT_FILE_NAME), b"not json").unwrap();
    let ResponseBody::Error(error) = one_frame(&run_handle(
        &corrupt_state,
        &reconcile_frame(signals::implementation_ready("evt-1"), "req-corrupt"),
    ))
    .body
    else {
        panic!("corrupt snapshot must remain unknown")
    };
    assert_eq!(error.code().as_str(), "JOURNAL_CORRUPT");
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
#[test]
fn lost_ack_is_reconciled_by_a_fresh_process_without_a_blind_retry() {
    let dir = TempDir::new();
    let state = dir.state();
    let signal = signals::implementation_ready("evt-lost-ack");

    let status =
        run_handle_without_observing_stdout(&state, &submit_frame("evt-lost-ack", "req-lost-ack"));
    assert!(status.success(), "the durable submit process must complete");

    let response = one_frame(&run_handle(
        &state,
        &reconcile_frame(signal, "req-reconcile-lost-ack"),
    ));
    let ResponseBody::WorkflowSignalReconciliation(result) = response.body else {
        panic!("fresh-process reconciliation must classify the committed signal")
    };
    assert_eq!(result.disposition, ReconciliationDisposition::Accepted);
    assert_eq!(result.event_id.as_str(), "evt-lost-ack");

    let journal = std::fs::read_to_string(state.join(JOURNAL_FILE_NAME)).unwrap();
    assert_eq!(
        journal.lines().count(),
        1,
        "reconciliation must not resubmit the signal"
    );
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
#[test]
fn restrictive_umask_is_normalized_before_acceptance() {
    use std::os::unix::fs::PermissionsExt as _;

    fn assert_reopenable_layout(state: &Path) {
        assert_eq!(
            std::fs::symlink_metadata(state)
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o700
        );
        for name in [LOCK_FILE_NAME, JOURNAL_FILE_NAME, COMMIT_FILE_NAME] {
            assert_eq!(
                std::fs::symlink_metadata(state.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                0o600,
                "{name}"
            );
        }
    }

    // Existing files are normal, but the next commit temp is created under
    // umask 0777. Publication must normalize it before returning accepted.
    let existing = TempDir::new();
    let existing_state = existing.state();
    drop(JsonlJournal::open(&existing_state).expect("initialize normal store"));
    let ResponseBody::WorkflowSignal(result) = one_frame(&run_handle_with_umask(
        &existing_state,
        &submit_frame("evt-umask-existing", "req-umask-existing"),
        "0777",
    ))
    .body
    else {
        panic!("restrictive-umask append must succeed")
    };
    assert_eq!(result.disposition, Disposition::Accepted);
    let ResponseBody::WorkflowSignalReconciliation(result) = one_frame(&run_handle(
        &existing_state,
        &reconcile_frame(
            signals::implementation_ready("evt-umask-existing"),
            "req-reconcile-umask-existing",
        ),
    ))
    .body
    else {
        panic!("fresh process must reopen the normalized commit metadata")
    };
    assert_eq!(result.disposition, ReconciliationDisposition::Accepted);
    assert_reopenable_layout(&existing_state);

    // Fresh initialization normalizes the directory, lock, journal, and
    // initial/replacement commit metadata under the same restrictive umask.
    let fresh = TempDir::new();
    let fresh_state = fresh.state();
    let ResponseBody::WorkflowSignal(result) = one_frame(&run_handle_with_umask(
        &fresh_state,
        &submit_frame("evt-umask-fresh", "req-umask-fresh"),
        "0777",
    ))
    .body
    else {
        panic!("restrictive-umask initialization must succeed")
    };
    assert_eq!(result.disposition, Disposition::Accepted);
    let ResponseBody::WorkflowSignalReconciliation(result) = one_frame(&run_handle(
        &fresh_state,
        &reconcile_frame(
            signals::implementation_ready("evt-umask-fresh"),
            "req-reconcile-umask-fresh",
        ),
    ))
    .body
    else {
        panic!("fresh process must reopen every normalized artifact")
    };
    assert_eq!(result.disposition, ReconciliationDisposition::Accepted);
    assert_reopenable_layout(&fresh_state);
}

#[test]
fn hello_request_frame_is_answered_with_its_request_id() {
    let dir = TempDir::new();
    let output = run_handle(
        &dir.state(),
        "{\"protocol\":\"aizign\",\"version\":1,\"requestId\":\"req-h\",\"kind\":\"hello\",\"payload\":{}}\n",
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

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
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
        assert_eq!(mode & 0o7777, 0o600);
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
    })
    .unwrap();
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

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
#[test]
fn stderr_carries_identity_and_codes_but_no_contents() {
    let dir = TempDir::new();
    let output = run_handle(&dir.state(), &submit_frame("evt-log", "req-log"));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("requestId=req-log"), "{stderr}");
    assert!(stderr.contains("outcome=accepted"), "{stderr}");
    assert!(
        !stderr.contains("aizign_timing:"),
        "stage timing is opt-in: {stderr}"
    );
    for secret in ["evt-log", "rev-a", "artifactRevision", "wf-test"] {
        assert!(
            !stderr.contains(secret),
            "stderr must not echo payload content: {stderr}"
        );
    }
}

#[test]
fn opt_in_timing_for_handle_hello_is_metadata_only() {
    let dir = TempDir::new();
    let output = run_handle_with_timing(
        &dir.state(),
        r#"{"protocol":"aizign","version":1,"requestId":"req-timing","kind":"hello","payload":{}}
"#,
    );
    let metric = timing_metric(&output);
    assert_eq!(metric["schema_version"], 1);
    assert_eq!(metric["operation_kind"], "hello");
    assert_eq!(metric["outcome"], "ok");
    for field in [
        "request_read_ms",
        "decode_ms",
        "response_encode_ms",
        "response_write_ms",
        "handler_total_ms",
    ] {
        assert!(metric[field].is_number(), "{field}: {metric}");
    }
    let encoded = metric.to_string();
    for forbidden in [
        "req-timing",
        "stateDir",
        "path",
        "prompt",
        "reasoning",
        "credential",
    ] {
        assert!(!encoded.contains(forbidden), "{forbidden}: {encoded}");
    }
}

#[test]
fn invalid_raw_kind_is_never_copied_into_timing() {
    let dir = TempDir::new();
    let secret_like_kind = "credential-or-prompt-material-here";
    let frame = format!(
        "{{\"protocol\":\"aizign\",\"version\":1,\"requestId\":\"req-invalid-kind\",\"kind\":\"{secret_like_kind}\",\"payload\":{{}}}}\n"
    );
    let output = run_handle_with_timing(&dir.state(), &frame);
    let metric = timing_metric(&output);
    assert_eq!(metric["operation_kind"], "unknown");
    assert_eq!(metric["outcome"], "rejected");
    assert!(!metric.to_string().contains(secret_like_kind));
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains(secret_like_kind)
    );
}

#[test]
fn response_unsafe_unknown_kind_uses_bounded_null_correlation() {
    let dir = TempDir::new();
    let long_kind = "x".repeat(65_000);
    let frame = format!(
        "{{\"protocol\":\"aizign\",\"version\":1,\"requestId\":\"req-long-kind\",\"kind\":\"{long_kind}\",\"payload\":{{}}}}\n"
    );
    assert!(frame.len() <= MAX_REQUEST_BYTES + 1);
    let output = run_handle(&dir.state(), &frame);
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stdout.len() <= aizign_protocol::MAX_FRAME_BYTES + 1);
    let response = one_frame(&output);
    assert_eq!(response.request_id.as_deref(), Some("req-long-kind"));
    assert_eq!(response.kind, None);
    let ResponseBody::Error(error) = response.body else {
        panic!("long unknown kind must be a bounded error")
    };
    assert_eq!(error.code().as_str(), codes::UNKNOWN_KIND);
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains(&long_kind)
    );
    assert!(!dir.state().exists());
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
#[test]
fn opt_in_submit_timing_reports_every_applicable_stage() {
    let dir = TempDir::new();
    let output = run_handle_with_timing(&dir.state(), &submit_frame("evt-timing", "req-timing"));
    assert!(matches!(
        one_frame(&output).body,
        ResponseBody::WorkflowSignal(_)
    ));
    let metric = timing_metric(&output);
    assert_eq!(metric["operation_kind"], "workflow.signal.submit");
    assert_eq!(metric["outcome"], "accepted");
    assert_eq!(metric["journal_entries"], 0);
    assert_eq!(metric["journal_physical_bytes"], 0);
    for field in [
        "journal_open_ms",
        "journal_load_decode_ms",
        "committed_prefix_read_ms",
        "committed_prefix_hash_ms",
        "committed_prefix_decode_ms",
        "replay_ms",
        "decide_us",
        "append_sync_ms",
        "publish_prefix_hash_ms",
    ] {
        assert!(metric[field].is_number(), "{field}: {metric}");
    }

    let output = run_handle_with_timing(
        &dir.state(),
        &reconcile_frame(
            signals::implementation_ready("evt-timing"),
            "req-timing-reconcile",
        ),
    );
    let metric = timing_metric(&output);
    assert_eq!(metric["operation_kind"], "workflow.signal.reconcile");
    assert_eq!(metric["outcome"], "accepted");
    for field in [
        "committed_prefix_read_ms",
        "committed_prefix_hash_ms",
        "committed_prefix_decode_ms",
        "replay_ms",
    ] {
        assert!(metric[field].is_number(), "{field}: {metric}");
    }
    assert!(metric.get("append_sync_ms").is_none());
    assert!(metric.get("publish_prefix_hash_ms").is_none());
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
#[test]
fn timing_does_not_change_submit_reconcile_or_open_error_outcomes() {
    let raw_dir = TempDir::new();
    let timed_dir = TempDir::new();
    let submit = submit_frame("evt-timing-equivalence", "req-timing-equivalence");

    let raw_submit = run_handle(&raw_dir.state(), &submit);
    let timed_submit = run_handle_with_timing(&timed_dir.state(), &submit);
    assert_eq!(raw_submit.status.code(), timed_submit.status.code());
    assert_eq!(one_frame(&raw_submit), one_frame(&timed_submit));

    let signal = signals::implementation_ready("evt-timing-equivalence");
    let reconcile = reconcile_frame(signal, "req-timing-equivalence-reconcile");
    let raw_reconcile = run_handle(&raw_dir.state(), &reconcile);
    let timed_reconcile = run_handle_with_timing(&timed_dir.state(), &reconcile);
    assert_eq!(raw_reconcile.status.code(), timed_reconcile.status.code());
    assert_eq!(one_frame(&raw_reconcile), one_frame(&timed_reconcile));

    let missing = TempDir::new().state();
    let raw_error = one_frame(&run_handle(&missing, &reconcile));
    let timed_error = one_frame(&run_handle_with_timing(&missing, &reconcile));
    let (ResponseBody::Error(raw_error), ResponseBody::Error(timed_error)) =
        (raw_error.body, timed_error.body)
    else {
        panic!("missing store must fail in both modes")
    };
    assert_eq!(raw_error.code(), timed_error.code());
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
fn lf_less_crlf_and_post_lf_requests_fail_before_state() {
    let cases = [
        (
            "lf-less-hello",
            "{\"protocol\":\"aizign\",\"version\":1,\"requestId\":\"req-h\",\"kind\":\"hello\",\"payload\":{}}"
                .to_owned(),
            codes::INVALID_ENVELOPE,
        ),
        (
            "lf-less-submit",
            submit_frame("evt-lf-less", "req-lf-less")
                .trim_end_matches('\n')
                .to_owned(),
            codes::INVALID_ENVELOPE,
        ),
        (
            "crlf",
            submit_frame("evt-crlf", "req-crlf").replace('\n', "\r\n"),
            codes::INVALID_ENVELOPE,
        ),
        (
            "post-lf-space",
            format!("{} ", submit_frame("evt-space", "req-space")),
            codes::INVALID_ENVELOPE,
        ),
        (
            "post-lf-tab",
            format!("{}\t", submit_frame("evt-tab", "req-tab")),
            codes::INVALID_ENVELOPE,
        ),
        (
            "post-lf-lf",
            format!("{}\n", submit_frame("evt-lf", "req-lf")),
            codes::INVALID_ENVELOPE,
        ),
    ];
    for (name, stream, expected) in cases {
        let dir = TempDir::new();
        let response = one_frame(&run_handle(&dir.state(), &stream));
        assert_eq!(response.request_id, None, "{name}");
        assert_eq!(response.kind, None, "{name}");
        let ResponseBody::Error(error) = response.body else {
            panic!("{name}: expected framing error")
        };
        assert_eq!(error.code().as_str(), expected, "{name}");
        assert!(!dir.state().exists(), "{name}: no state artifact");
    }

    let dir = TempDir::new();
    let over_bound_crlf = format!("{}\r\n", " ".repeat(MAX_REQUEST_BYTES));
    let ResponseBody::Error(error) = one_frame(&run_handle(&dir.state(), &over_bound_crlf)).body
    else {
        panic!("over-bound CRLF must fail")
    };
    assert_eq!(error.code().as_str(), codes::REQUEST_TOO_LARGE);
    assert!(!dir.state().exists());
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

    // Every byte after the terminating LF is a profile error, including whitespace.
    let whitespace = format!("{}\n  \n", submit_frame("evt-a", "req-ws"));
    let ResponseBody::Error(error) = one_frame(&run_handle(&dir.state(), &whitespace)).body else {
        panic!("post-LF whitespace must fail")
    };
    assert_eq!(error.code().as_str(), codes::INVALID_ENVELOPE);
    assert!(
        !dir.state().exists(),
        "profile rejection has no state effect"
    );
}

/// Pads a frame with trailing spaces (inside the frame, before its newline)
/// to exactly `MAX_REQUEST_BYTES`, the largest size the protocol accepts.
#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn frame_at_size_bound(event_id: &str, request_id: &str) -> String {
    let frame = submit_frame(event_id, request_id);
    let body = frame.trim_end_matches('\n');
    assert!(body.len() < MAX_REQUEST_BYTES);
    format!("{body}{}\n", " ".repeat(MAX_REQUEST_BYTES - body.len()))
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
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
    let exact_without_lf = " ".repeat(MAX_REQUEST_BYTES);
    for (name, bytes) in [
        ("zero", String::new()),
        ("partial", "{\"protocol\":\"aizign\"".to_owned()),
        ("exact-without-lf", exact_without_lf),
        ("lf-awaiting-eof", submit_frame("evt-held", "req-held")),
    ] {
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
        stdin.write_all(bytes.as_bytes()).unwrap();
        stdin.flush().unwrap();

        let started = std::time::Instant::now();
        let output = child.wait_with_output().expect("wait for aizign");
        drop(stdin);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{name}: watchdog must not wait forever"
        );
        let ResponseBody::Error(error) = one_frame(&output).body else {
            panic!("{name}: expected timeout")
        };
        assert_eq!(error.code().as_str(), codes::HANDLER_TIMEOUT, "{name}");
        assert!(
            !dir.state().exists(),
            "{name}: pre-dispatch timeout has no state effect"
        );
    }
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
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

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
#[test]
fn unsupported_storage_platform_advertises_no_store_capability_and_rejects_direct_requests() {
    let hello = one_frame(&aizign().arg("hello").output().unwrap());
    let ResponseBody::Hello(info) = hello.body else {
        panic!("hello response")
    };
    assert!(info.capabilities.is_empty());

    let dir = TempDir::new();
    for frame in [
        submit_frame("evt-unsupported", "req-submit-unsupported"),
        reconcile_frame(
            signals::implementation_ready("evt-unsupported"),
            "req-reconcile-unsupported",
        ),
    ] {
        let ResponseBody::Error(error) = one_frame(&run_handle(&dir.state(), &frame)).body else {
            panic!("unsupported request must fail")
        };
        assert_eq!(error.code().as_str(), codes::CAPABILITY_UNSUPPORTED);
    }
    assert!(
        !dir.state().exists(),
        "unsupported requests must not create state"
    );
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
