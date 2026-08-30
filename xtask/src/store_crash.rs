//! Launcher and repository-side audits for the private store crash harness.

use std::collections::BTreeSet;
use std::fs;
use std::io::Read as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::{report, shell};

const EVIDENCE_PREFIX: &str = "AIZIGN_STORE_CRASH_EVIDENCE=";
const PROFILE: &str = "linux-x86_64-gnu-ext4-local-v1";
const TARGET_TRIPLE: &str = "x86_64-unknown-linux-gnu";
const RUST_TOOLCHAIN: &str = "1.97.1";
const HARNESS_VERSION: u64 = 1;
const SCENARIO_COUNT: u64 = 61;
const MUTATION_SENTINEL_COUNT: u64 = 9;
const COMMAND_DEADLINE: Duration = Duration::from_mins(4);

#[derive(Clone, Copy)]
struct MutationSpec {
    id: &'static str,
    relative: &'static str,
    test: &'static str,
    kind: MutationKind,
}

#[derive(Clone, Copy)]
enum MutationKind {
    BarrierFile(&'static str),
    JournalBarrier,
    BarrierDirectory,
    CommitBeforeJournalBarrier,
    ReaderAcceptsIncomplete,
    TailRepairOrPromotion,
    AppendRevalidationBypass,
}

const MUTATIONS: [MutationSpec; 9] = [
    MutationSpec {
        id: "mutation-prepared-barrier-noop",
        relative: "crates/aizign-store-jsonl/src/durability.rs",
        test: "crash_harness::tests::sentinel_prepared_barrier_required",
        kind: MutationKind::BarrierFile("PreparedBarrierComplete"),
    },
    MutationSpec {
        id: "mutation-journal-barrier-noop",
        relative: "crates/aizign-store-jsonl/src/journal.rs",
        test: "crash_harness::tests::sentinel_journal_barrier_required",
        kind: MutationKind::JournalBarrier,
    },
    MutationSpec {
        id: "mutation-commit-temporary-barrier-noop",
        relative: "crates/aizign-store-jsonl/src/durability.rs",
        test: "crash_harness::tests::sentinel_commit_temporary_barrier_required",
        kind: MutationKind::BarrierFile("CommitTemporaryBarrierComplete"),
    },
    MutationSpec {
        id: "mutation-commit-directory-barrier-noop",
        relative: "crates/aizign-store-jsonl/src/durability.rs",
        test: "crash_harness::tests::sentinel_commit_directory_barrier_required",
        kind: MutationKind::BarrierDirectory,
    },
    MutationSpec {
        id: "mutation-clean-barrier-noop",
        relative: "crates/aizign-store-jsonl/src/durability.rs",
        test: "crash_harness::tests::sentinel_clean_barrier_required",
        kind: MutationKind::BarrierFile("CleanBarrierComplete"),
    },
    MutationSpec {
        id: "mutation-commit-before-journal-barrier",
        relative: "crates/aizign-store-jsonl/src/journal.rs",
        test: "crash_harness::tests::sentinel_commit_follows_journal_barrier",
        kind: MutationKind::CommitBeforeJournalBarrier,
    },
    MutationSpec {
        id: "mutation-reader-accepts-incomplete-generation",
        relative: "crates/aizign-store-jsonl/src/journal.rs",
        test: "crash_harness::tests::sentinel_reader_rejects_initialization_prepared",
        kind: MutationKind::ReaderAcceptsIncomplete,
    },
    MutationSpec {
        id: "mutation-tail-repair-or-promotion",
        relative: "crates/aizign-store-jsonl/src/journal.rs",
        test: "crash_harness::tests::sentinel_reader_never_promotes_extra_tail",
        kind: MutationKind::TailRepairOrPromotion,
    },
    MutationSpec {
        id: "mutation-append-revalidation-bypass",
        relative: "crates/aizign-store-jsonl/src/journal.rs",
        test: "crash_harness::tests::sentinel_append_revalidates_committed_prefix",
        kind: MutationKind::AppendRevalidationBypass,
    },
];

const EVIDENCE_KEYS: [&str; 14] = [
    "profile",
    "targetTriple",
    "pointerWidth",
    "rustToolchain",
    "rustcVersion",
    "kernelRelease",
    "filesystemType",
    "filesystemMagic",
    "mountReadOnly",
    "superblockReadOnly",
    "deviceMatches",
    "harnessVersion",
    "scenarioCount",
    "mutationSentinelCount",
];

pub(crate) fn run(root: &Path) -> Result<(), String> {
    let deadline = Instant::now() + COMMAND_DEADLINE;
    report::stage("store crash harness source and response-order audit");
    audit_private_surface(root)?;
    audit_writer_mutations(root)?;
    audit_harness_shape(root)?;
    audit_cli_response_order(root)?;
    audit_mutation_targets(root)?;
    println!("store crash source audits: ok");

    if !cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    )) {
        return Err(format!(
            "store-crash-check requires the supported {TARGET_TRIPLE} 64-bit Linux profile"
        ));
    }

    let rustc_version = selected_rustc_version(root)?;
    report::stage("store crash mutation campaign");
    run_mutation_campaign(root, deadline)?;
    report::stage("store crash-stage matrix");
    let output = run_parent_matrix(root, deadline)?;
    print_captured_output(&output.stdout, &output.stderr);
    if !output.status.success() {
        return Err(format!(
            "store crash-stage matrix exited with {}",
            output.status
        ));
    }
    validate_evidence(&output.stdout, &rustc_version)?;
    println!("store crash evidence: ok");
    Ok(())
}

struct CapturedOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_parent_matrix(root: &Path, deadline: Instant) -> Result<CapturedOutput, String> {
    let rendered = "cargo test -p aizign-store-jsonl \
        crash_harness::tests::supported_linux_crash_matrix \
        -- --exact --ignored --nocapture";
    println!("$ {rendered}");
    let mut command = Command::new("cargo");
    command
        .args([
            "test",
            "-p",
            "aizign-store-jsonl",
            "crash_harness::tests::supported_linux_crash_matrix",
            "--",
            "--exact",
            "--ignored",
            "--nocapture",
        ])
        .current_dir(root);
    run_command_bounded(command, rendered, deadline)
}

fn run_command_bounded(
    mut command: Command,
    rendered: &str,
    deadline: Instant,
) -> Result<CapturedOutput, String> {
    if Instant::now() >= deadline {
        return Err("store-crash-check exceeded the four-minute deadline".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start `{rendered}`: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("failed to capture stdout for `{rendered}`"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("failed to capture stderr for `{rendered}`"))?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                kill_command_tree(&mut child);
                let _ = child.wait();
                return Err(format!("`{rendered}` exceeded the four-minute deadline"));
            }
            Err(error) => {
                kill_command_tree(&mut child);
                let _ = child.wait();
                return Err(format!("failed while waiting for `{rendered}`: {error}"));
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| format!("stdout reader panicked for `{rendered}`"))?
        .map_err(|error| format!("cannot read stdout for `{rendered}`: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("stderr reader panicked for `{rendered}`"))?
        .map_err(|error| format!("cannot read stderr for `{rendered}`: {error}"))?;
    Ok(CapturedOutput {
        status,
        stdout,
        stderr,
    })
}

fn kill_command_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let group = format!("-{}", child.id());
        let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
    }
    #[cfg(not(unix))]
    let _ = child.kill();
}

fn print_captured_output(stdout: &[u8], stderr: &[u8]) {
    if !stdout.is_empty() {
        print!("{}", String::from_utf8_lossy(stdout));
    }
    if !stderr.is_empty() {
        eprint!("{}", String::from_utf8_lossy(stderr));
    }
}

struct TemporaryCandidate {
    path: std::path::PathBuf,
}

impl Drop for TemporaryCandidate {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn run_mutation_campaign(root: &Path, deadline: Instant) -> Result<(), String> {
    if MUTATIONS.len() as u64 != MUTATION_SENTINEL_COUNT {
        return Err("mutation campaign manifest count is not exactly nine".to_owned());
    }
    let ids: BTreeSet<&str> = MUTATIONS.iter().map(|mutation| mutation.id).collect();
    if ids.len() != MUTATIONS.len() {
        return Err("mutation campaign contains a duplicate ID".to_owned());
    }
    let candidate = copy_candidate(root)?;
    let target = candidate.path.join("target");
    let mut executed = BTreeSet::new();
    for mutation in MUTATIONS {
        if Instant::now() >= deadline {
            return Err("mutation campaign exceeded the four-minute deadline".to_owned());
        }
        println!("mutation sentinel: {}", mutation.id);
        let path = candidate.path.join(mutation.relative);
        let original = fs::read_to_string(&path)
            .map_err(|error| format!("cannot read {}: {error}", mutation.relative))?;
        let mutant = apply_mutation(&original, mutation)?;

        let restored_before = run_focused_test(&candidate.path, &target, mutation, deadline)?;
        require_green_focused(&restored_before, mutation, "before mutation")?;

        fs::write(&path, mutant)
            .map_err(|error| format!("cannot apply {}: {error}", mutation.id))?;
        let mutant_output = run_focused_test(&candidate.path, &target, mutation, deadline);
        fs::write(&path, &original)
            .map_err(|error| format!("cannot restore {}: {error}", mutation.relative))?;
        let mutant_output = mutant_output?;
        require_detected_mutant(&mutant_output, mutation)?;

        let restored_after = run_focused_test(&candidate.path, &target, mutation, deadline)?;
        require_green_focused(&restored_after, mutation, "after restoration")?;
        let restored = fs::read_to_string(&path)
            .map_err(|error| format!("cannot reread {}: {error}", mutation.relative))?;
        if restored != original {
            return Err(format!(
                "{} did not restore the exact candidate",
                mutation.id
            ));
        }
        if !executed.insert(mutation.id) {
            return Err(format!("{} executed more than once", mutation.id));
        }
    }
    if executed != ids {
        return Err("mutation campaign execution set is incomplete".to_owned());
    }
    println!("nine mutation sentinels detected and restored: ok");
    Ok(())
}

fn copy_candidate(root: &Path) -> Result<TemporaryCandidate, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock is before UNIX epoch: {error}"))?
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("aizign-store-crash-{}-{nonce}", std::process::id()));
    fs::create_dir(&path).map_err(|error| {
        format!(
            "cannot create throwaway candidate {}: {error}",
            path.display()
        )
    })?;
    let candidate = TemporaryCandidate { path };
    let listing = shell::capture(
        root,
        "git",
        &["ls-files", "-co", "--exclude-standard", "-z"],
    )?;
    for relative in listing.split('\0').filter(|entry| !entry.is_empty()) {
        let relative_path = Path::new(relative);
        if relative_path.is_absolute()
            || relative_path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(format!(
                "unsafe candidate path returned by git: {relative:?}"
            ));
        }
        let source = root.join(relative_path);
        let metadata = fs::symlink_metadata(&source)
            .map_err(|error| format!("cannot inspect {relative}: {error}"))?;
        if !metadata.file_type().is_file() {
            return Err(format!(
                "throwaway candidate supports tracked regular files only: {relative}"
            ));
        }
        let destination = candidate.path.join(relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        }
        fs::copy(&source, &destination)
            .map_err(|error| format!("cannot copy {relative} into throwaway candidate: {error}"))?;
    }
    Ok(candidate)
}

fn run_focused_test(
    candidate: &Path,
    target: &Path,
    mutation: MutationSpec,
    deadline: Instant,
) -> Result<CapturedOutput, String> {
    let rendered = format!(
        "cargo test -p aizign-store-jsonl {} -- --exact --nocapture",
        mutation.test
    );
    let mut command = Command::new("cargo");
    command
        .args([
            "test",
            "-p",
            "aizign-store-jsonl",
            mutation.test,
            "--",
            "--exact",
            "--nocapture",
        ])
        .env("CARGO_TARGET_DIR", target)
        .current_dir(candidate);
    run_command_bounded(command, &rendered, deadline)
}

fn combined_output(output: &CapturedOutput) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn require_green_focused(
    output: &CapturedOutput,
    mutation: MutationSpec,
    stage: &str,
) -> Result<(), String> {
    let combined = combined_output(output);
    let executed = format!("test {} ... ok", mutation.test);
    if !output.status.success()
        || combined.matches(&executed).count() != 1
        || !combined.contains("test result: ok. 1 passed; 0 failed")
    {
        return Err(format!(
            "{} focused sentinel was not exactly one green executed test {stage}: {}",
            mutation.id,
            bounded_failure(&combined)
        ));
    }
    Ok(())
}

fn require_detected_mutant(output: &CapturedOutput, mutation: MutationSpec) -> Result<(), String> {
    let combined = combined_output(output);
    let failed = format!("test {} ... FAILED", mutation.test);
    if output.status.success()
        || combined.matches(&failed).count() != 1
        || !combined.contains("test result: FAILED")
        || !combined.contains("1 failed")
        || !combined.contains("panicked at")
        || !combined.contains("assertion failure: mutation sentinel")
    {
        return Err(format!(
            "{} was not detected by an executed assertion failure: {}",
            mutation.id,
            bounded_failure(&combined)
        ));
    }
    Ok(())
}

fn bounded_failure(output: &str) -> String {
    const MAX: usize = 4_096;
    if output.chars().count() <= MAX {
        output.to_owned()
    } else {
        format!(
            "{}...[truncated]",
            output.chars().take(MAX).collect::<String>()
        )
    }
}

fn audit_mutation_targets(root: &Path) -> Result<(), String> {
    for mutation in MUTATIONS {
        let source = read_source(root, mutation.relative)?;
        let mutant = apply_mutation(&source, mutation)?;
        if mutant == source {
            return Err(format!(
                "{} did not change its candidate expression",
                mutation.id
            ));
        }
    }
    Ok(())
}

fn apply_mutation(source: &str, mutation: MutationSpec) -> Result<String, String> {
    match mutation.kind {
        MutationKind::BarrierFile(point) => mutate_function_once(
            source,
            "barrier_file",
            "file.sync_all()?;",
            &format!(
                "if point != DurabilityPoint::{point} {{\n            file.sync_all()?;\n        }}"
            ),
            mutation.id,
        ),
        MutationKind::JournalBarrier => mutate_function_once(
            source,
            "append_with_ops",
            "durability\n            .barrier_file(&journal_file, DurabilityPoint::JournalBarrierComplete)",
            "std::io::Result::<()>::Ok(())",
            mutation.id,
        ),
        MutationKind::BarrierDirectory => mutate_function_once(
            source,
            "barrier_directory",
            "directory.sync_all()?;",
            "if point != DurabilityPoint::CommitDirectoryBarrierComplete {\n            directory.sync_all()?;\n        }",
            mutation.id,
        ),
        MutationKind::CommitBeforeJournalBarrier => mutate_commit_order(source, mutation.id),
        MutationKind::ReaderAcceptsIncomplete => mutate_function_once(
            source,
            "read_snapshot_observed",
            "return Err(unavailable(\"store initialization is PREPARED\"));",
            "return Ok(Snapshot { point, bytes: Vec::new(), entries: Vec::new() });",
            mutation.id,
        ),
        MutationKind::TailRepairOrPromotion => mutate_tail(source, mutation.id),
        MutationKind::AppendRevalidationBypass => mutate_function_once(
            source,
            "read_snapshot_observed",
            "    if digest != point.digest {\n        return Err(corrupt(\n            \"journal prefix does not match the published SHA-256 digest\",\n        ));\n    }\n",
            "",
            mutation.id,
        ),
    }
}

fn mutate_commit_order(source: &str, id: &str) -> Result<String, String> {
    let barrier = "        durability\n            .barrier_file(&journal_file, DurabilityPoint::JournalBarrierComplete)\n            .map_err(|error| outcome_unknown(format!(\"journal barrier failed: {error}\")))?;\n\n";
    let publish = "        publish_commit(\n            &state_directory,\n            &state_profile,\n            &commit_path,\n            &next_point,\n            durability,\n            profile,\n            true,\n        )?;\n";
    let without = mutate_function_once(source, "append_with_ops", barrier, "", id)?;
    mutate_function_once(
        &without,
        "append_with_ops",
        publish,
        &format!("{publish}{barrier}"),
        id,
    )
}

fn mutate_tail(source: &str, id: &str) -> Result<String, String> {
    let branch = "        if physical_len > point.committed_bytes {\n            return Err(outcome_unknown(\n                \"journal contains bytes beyond the clean commit point\",\n            ));\n        }\n";
    let without_branch = mutate_function_once(source, "read_snapshot_observed", branch, "", id)?;
    mutate_function_once(
        &without_branch,
        "read_snapshot_observed",
        ".take(point.committed_bytes.saturating_add(1))",
        ".take(point.committed_bytes)",
        id,
    )
}

fn mutate_function_once(
    source: &str,
    function: &str,
    old: &str,
    new: &str,
    id: &str,
) -> Result<String, String> {
    let (start, end) = function_body_range(source, function)?;
    let body = &source[start..end];
    let count = body.matches(old).count();
    if count != 1 {
        return Err(format!(
            "{id} expected exactly one candidate expression in {function}, found {count}"
        ));
    }
    let replaced = body.replacen(old, new, 1);
    Ok(format!(
        "{}{}{}",
        &source[..start],
        replaced,
        &source[end..]
    ))
}

fn selected_rustc_version(root: &Path) -> Result<String, String> {
    let toolchain = fs::read_to_string(root.join("rust-toolchain.toml"))
        .map_err(|error| format!("cannot read rust-toolchain.toml: {error}"))?;
    let exact_channel = format!("channel = \"{RUST_TOOLCHAIN}\"");
    if toolchain.matches(&exact_channel).count() != 1 {
        return Err(format!(
            "rust-toolchain.toml must select exact channel {RUST_TOOLCHAIN}"
        ));
    }
    let raw = shell::capture(root, "rustc", &["--version"])?;
    let normalized = normalize_one_line(raw.as_bytes(), "rustc --version")?;
    let mut words = normalized.split_ascii_whitespace();
    if words.next() != Some("rustc") || words.next() != Some(RUST_TOOLCHAIN) {
        return Err(format!(
            "rustc --version does not correspond to selected toolchain {RUST_TOOLCHAIN}: {normalized}"
        ));
    }
    Ok(normalized)
}

fn normalize_one_line(raw: &[u8], label: &str) -> Result<String, String> {
    let mut value = raw;
    if value.ends_with(b"\n") {
        value = &value[..value.len() - 1];
        if value.ends_with(b"\r") {
            value = &value[..value.len() - 1];
        }
    }
    if value.is_empty() || value.len() > 256 || value.contains(&b'\r') || value.contains(&b'\n') {
        return Err(format!(
            "{label} must be one non-empty UTF-8 line of at most 256 bytes"
        ));
    }
    String::from_utf8(value.to_vec()).map_err(|error| format!("{label} is not UTF-8: {error}"))
}

fn validate_evidence(stdout: &[u8], rustc_version: &str) -> Result<(), String> {
    let stdout = std::str::from_utf8(stdout)
        .map_err(|error| format!("store crash harness stdout is not UTF-8: {error}"))?;
    let candidate_lines: Vec<&str> = stdout
        .lines()
        .filter(|line| line.contains(EVIDENCE_PREFIX))
        .collect();
    if candidate_lines.len() != 1 {
        return Err(format!(
            "expected exactly one {EVIDENCE_PREFIX} record, found {}",
            candidate_lines.len()
        ));
    }
    let record = candidate_lines[0]
        .strip_prefix(EVIDENCE_PREFIX)
        .ok_or_else(|| "store crash evidence prefix must begin its own line".to_owned())?;
    let value: Value = serde_json::from_str(record)
        .map_err(|error| format!("malformed store crash evidence JSON: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "store crash evidence must be a JSON object".to_owned())?;
    require_exact_keys(object)?;
    require_string(object, "profile", PROFILE)?;
    require_string(object, "targetTriple", TARGET_TRIPLE)?;
    require_u64(object, "pointerWidth", 64)?;
    require_string(object, "rustToolchain", RUST_TOOLCHAIN)?;
    require_string(object, "rustcVersion", rustc_version)?;
    require_bounded_line(object, "kernelRelease")?;
    require_string(object, "filesystemType", "ext4")?;
    require_string(object, "filesystemMagic", "0xef53")?;
    require_bool(object, "mountReadOnly", false)?;
    require_bool(object, "superblockReadOnly", false)?;
    require_bool(object, "deviceMatches", true)?;
    require_u64(object, "harnessVersion", HARNESS_VERSION)?;
    require_u64(object, "scenarioCount", SCENARIO_COUNT)?;
    require_u64(object, "mutationSentinelCount", MUTATION_SENTINEL_COUNT)?;
    Ok(())
}

fn require_exact_keys(object: &Map<String, Value>) -> Result<(), String> {
    let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    let expected: BTreeSet<&str> = EVIDENCE_KEYS.into_iter().collect();
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "store crash evidence keys differ: expected {expected:?}, found {actual:?}"
        ))
    }
}

fn require_string(object: &Map<String, Value>, key: &str, expected: &str) -> Result<(), String> {
    match object.get(key).and_then(Value::as_str) {
        Some(actual) if actual == expected => Ok(()),
        actual => Err(format!(
            "store crash evidence {key} must be {expected:?}, found {actual:?}"
        )),
    }
}

fn require_u64(object: &Map<String, Value>, key: &str, expected: u64) -> Result<(), String> {
    match object.get(key).and_then(Value::as_u64) {
        Some(actual) if actual == expected => Ok(()),
        actual => Err(format!(
            "store crash evidence {key} must be {expected}, found {actual:?}"
        )),
    }
}

fn require_bool(object: &Map<String, Value>, key: &str, expected: bool) -> Result<(), String> {
    match object.get(key).and_then(Value::as_bool) {
        Some(actual) if actual == expected => Ok(()),
        actual => Err(format!(
            "store crash evidence {key} must be {expected}, found {actual:?}"
        )),
    }
}

fn require_bounded_line(object: &Map<String, Value>, key: &str) -> Result<(), String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("store crash evidence {key} must be a string"))?;
    if value.is_empty() || value.len() > 256 || value.contains(['\r', '\n']) {
        return Err(format!(
            "store crash evidence {key} must be one non-empty line of at most 256 bytes"
        ));
    }
    Ok(())
}

fn read_source(root: &Path, relative: &str) -> Result<String, String> {
    fs::read_to_string(root.join(relative))
        .map_err(|error| format!("cannot read {relative}: {error}"))
}

fn audit_private_surface(root: &Path) -> Result<(), String> {
    let manifest = read_source(root, "crates/aizign-store-jsonl/Cargo.toml")?;
    for forbidden in ["[features]", "[[bin]]", "[[test]]"] {
        if manifest.lines().any(|line| line.trim() == forbidden) {
            return Err(format!(
                "store crash harness must not add manifest surface {forbidden}"
            ));
        }
    }
    let lib = read_source(root, "crates/aizign-store-jsonl/src/lib.rs")?;
    let compact_lib: String = lib.split_whitespace().collect();
    if compact_lib.matches("#[cfg(test)]modcrash_harness;").count() != 1 {
        return Err("lib.rs must declare only private #[cfg(test)] mod crash_harness".to_owned());
    }
    for forbidden in [
        "pub mod crash_harness",
        "pub(crate) mod crash_harness",
        "pub use crash_harness",
        "pub(crate) use crash_harness",
    ] {
        if lib.contains(forbidden) {
            return Err(format!(
                "store crash harness leaked through lib.rs: {forbidden}"
            ));
        }
    }
    for relative in [
        "crates/aizign-store-jsonl/src/durability.rs",
        "crates/aizign-store-jsonl/src/crash_harness.rs",
    ] {
        let source = read_source(root, relative)?;
        if source.contains("#[cfg(feature") || source.contains("cfg!(feature") {
            return Err(format!(
                "{relative} must not add a feature-gated crash path"
            ));
        }
        for line in source.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("pub ")
                || trimmed.starts_with("pub async ")
                || trimmed.starts_with("pub const ")
            {
                return Err(format!(
                    "{relative} exposes a public crash-harness item: {trimmed}"
                ));
            }
        }
    }
    Ok(())
}

fn audit_writer_mutations(root: &Path) -> Result<(), String> {
    let journal = read_source(root, "crates/aizign-store-jsonl/src/journal.rs")?;
    let forbidden = [
        ".write_all(",
        ".set_len(",
        ".sync_all(",
        "std::fs::rename(",
        "fs::rename(",
        "std::fs::remove_file(",
        "fs::remove_file(",
        "std::fs::set_permissions(",
        "fs::set_permissions(",
        "DirBuilder::new(",
        ".write(true)",
        ".write(!append)",
        ".append(append)",
        ".create(true)",
        ".create_new(",
        ".truncate(true)",
    ];
    let mut findings = Vec::new();
    for needle in forbidden {
        for (index, line) in journal.lines().enumerate() {
            if line.contains(needle) {
                findings.push(format!("journal.rs:{} contains {needle}", index + 1));
            }
        }
    }
    if !findings.is_empty() {
        return Err(format!(
            "normal-writer persistent mutation remains outside durability.rs: {}",
            findings.join(", ")
        ));
    }
    if journal.matches(".replace_private_writable(").count() != 1 {
        return Err(
            "journal.rs must delegate exactly one secure commit-temporary replacement".to_owned(),
        );
    }
    let durability = read_source(root, "crates/aizign-store-jsonl/src/durability.rs")?;
    let replace = function_body(&durability, "replace_private_writable")?;
    ordered(
        replace,
        &[
            "std::fs::remove_file(path)?",
            "self.open_private_writable(path, true, false)?",
            "self.primitive_complete(",
            "self.normalize_private_file(",
        ],
        "secure commit-temporary replacement must remain one adapter-owned composite",
    )?;
    Ok(())
}

fn audit_harness_shape(root: &Path) -> Result<(), String> {
    let harness = read_source(root, "crates/aizign-store-jsonl/src/crash_harness.rs")?;
    for required in [
        "const SCENARIOS:",
        "assert_eq!(SCENARIOS.len(), 61",
        "for scenario in SCENARIOS",
        "execute_scenario(scenario)?",
        "const RESULT_EXPECTATIONS:",
        "RESULT_EXPECTATIONS.len(),\n        18",
        "validate_role_pair(scenario, role)?",
        "Role::Holder",
        "Role::ResponseChild",
        "Role::Inspector",
        "Role::Contender",
        "const ACK: &[u8; 26] = b\"AIZIGN_STORE_CRASH_ACK_V1\\n\";",
        ".stdout(Stdio::piped())",
        ".stderr(Stdio::piped())",
        "io::stdout().lock()",
        "io::stderr().lock()",
    ] {
        if !harness.contains(required) {
            return Err(format!(
                "crash harness closed ledger/role/stream audit is missing {required:?}"
            ));
        }
    }
    if harness.matches("RESULT_EXPECTATIONS").count() < 3 {
        return Err(
            "the closed 18-row result manifest must be declared, validated, and consumed"
                .to_owned(),
        );
    }
    Ok(())
}

fn audit_cli_response_order(root: &Path) -> Result<(), String> {
    let source = read_source(root, "crates/aizign-cli/src/run.rs")?;
    let respond = function_body(&source, "respond")?;
    ordered(
        respond,
        &["let body = execute_request(", "Response {", "body,"],
        "respond must obtain execute_request body before constructing its response",
    )?;
    let handle = function_body(&source, "handle")?;
    ordered(
        handle,
        &["receiver.recv_timeout(", "handled.response"],
        "main-thread response writing must remain downstream of the worker result",
    )?;
    if !handle.contains("sender.send(outcome.map(|response| WorkerResponse { response, timing }))")
    {
        return Err("handle worker must send the completed respond result".to_owned());
    }
    for name in ["write_frame", "write_measured_frame"] {
        let body = function_body(&source, name)?;
        ordered(
            body,
            &["encode_response(response)", ".write_all(", "stdout.flush()"],
            &format!("{name} must encode before stdout write_all and flush"),
        )?;
    }
    Ok(())
}

fn ordered(haystack: &str, needles: &[&str], message: &str) -> Result<(), String> {
    let mut offset = 0;
    for needle in needles {
        let found = haystack[offset..]
            .find(needle)
            .ok_or_else(|| format!("source-order audit: {message}; missing {needle:?}"))?;
        offset += found + needle.len();
    }
    Ok(())
}

fn function_body<'a>(source: &'a str, name: &str) -> Result<&'a str, String> {
    let (start, end) = function_body_range(source, name)?;
    Ok(&source[start..end])
}

fn function_body_range(source: &str, name: &str) -> Result<(usize, usize), String> {
    let marker = format!("fn {name}(");
    let start = source
        .find(&marker)
        .ok_or_else(|| format!("CLI response-order audit cannot find function {name}"))?;
    let open = source[start..]
        .find('{')
        .map(|offset| start + offset)
        .ok_or_else(|| format!("CLI response-order audit cannot find body for {name}"))?;
    let mut depth = 0_u32;
    for (offset, character) in source[open..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| format!("unbalanced function body for {name}"))?;
                if depth == 0 {
                    return Ok((open + 1, open + offset));
                }
            }
            _ => {}
        }
    }
    Err(format!("unterminated function body for {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_evidence(rustc: &str) -> String {
        format!(
            "noise\n{EVIDENCE_PREFIX}{{\"profile\":\"{PROFILE}\",\"targetTriple\":\"{TARGET_TRIPLE}\",\"pointerWidth\":64,\"rustToolchain\":\"{RUST_TOOLCHAIN}\",\"rustcVersion\":{rustc:?},\"kernelRelease\":\"test-kernel\",\"filesystemType\":\"ext4\",\"filesystemMagic\":\"0xef53\",\"mountReadOnly\":false,\"superblockReadOnly\":false,\"deviceMatches\":true,\"harnessVersion\":1,\"scenarioCount\":61,\"mutationSentinelCount\":9}}\ntest result: ok\n"
        )
    }

    #[test]
    fn evidence_is_closed_and_exact() {
        let rustc = "rustc 1.97.1 (test 2026-01-01)";
        assert!(validate_evidence(valid_evidence(rustc).as_bytes(), rustc).is_ok());
        let duplicate = format!("{}{}", valid_evidence(rustc), valid_evidence(rustc));
        assert!(validate_evidence(duplicate.as_bytes(), rustc).is_err());
        let extra = valid_evidence(rustc).replace(
            "\"mutationSentinelCount\":9",
            "\"mutationSentinelCount\":9,\"path\":\"private\"",
        );
        assert!(validate_evidence(extra.as_bytes(), rustc).is_err());
        let indented =
            valid_evidence(rustc).replace(EVIDENCE_PREFIX, &format!("  {EVIDENCE_PREFIX}"));
        assert!(validate_evidence(indented.as_bytes(), rustc).is_err());
    }

    #[test]
    fn rustc_version_normalization_is_single_line_and_bounded() {
        assert_eq!(
            normalize_one_line(b"rustc 1.97.1 (test)\r\n", "rustc").unwrap(),
            "rustc 1.97.1 (test)"
        );
        assert!(normalize_one_line(b"rustc 1.97.1\nextra\n", "rustc").is_err());
        assert!(normalize_one_line(&vec![b'x'; 257], "rustc").is_err());
    }

    #[test]
    fn function_extraction_and_order_are_item_scoped() {
        let source = "fn other() { second(); }\nfn target() { first(); second(); }\n";
        let body = function_body(source, "target").unwrap();
        assert!(ordered(body, &["first()", "second()"], "order").is_ok());
        assert!(ordered(body, &["second()", "first()"], "order").is_err());
    }

    #[test]
    fn repository_cli_preserves_response_order() {
        audit_cli_response_order(&shell::repository_root()).unwrap();
    }

    #[test]
    fn repository_mutation_targets_are_exact_and_unique() {
        audit_mutation_targets(&shell::repository_root()).unwrap();
    }
}
