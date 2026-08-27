//! Process helpers: locating the repository and running external commands.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The repository root, derived from this crate's manifest directory so the
/// commands work from any working directory.
pub(crate) fn repository_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(manifest_dir)
}

/// Runs a command with inherited stdio and fails if it does not exit 0.
pub(crate) fn run(root: &Path, program: &str, args: &[&str]) -> Result<(), String> {
    run_with_env(root, program, args, &[])
}

/// Like [`run`], with extra environment variables for the child.
pub(crate) fn run_with_env(
    root: &Path,
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<(), String> {
    let rendered = render(program, args);
    println!("$ {rendered}");
    let status = Command::new(program)
        .args(args)
        .envs(env.iter().copied())
        .current_dir(root)
        .status()
        .map_err(|error| format!("failed to start `{rendered}`: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("`{rendered}` exited with {status}"))
    }
}

/// Runs a command and returns its stdout as UTF-8, failing on non-zero exit.
pub(crate) fn capture(root: &Path, program: &str, args: &[&str]) -> Result<String, String> {
    capture_with_env(root, program, args, &[])
}

/// Like [`capture`], with extra environment variables for the child.
pub(crate) fn capture_with_env(
    root: &Path,
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<String, String> {
    capture_output(root, program, args, false, env)
}

fn capture_output(
    root: &Path,
    program: &str,
    args: &[&str],
    include_stdout_on_error: bool,
    env: &[(&str, &str)],
) -> Result<String, String> {
    let rendered = render(program, args);
    let output = Command::new(program)
        .args(args)
        .envs(env.iter().copied())
        .current_dir(root)
        .output()
        .map_err(|error| format!("failed to start `{rendered}`: {error}"))?;
    if !output.status.success() {
        let details = failure_details(&output.stderr, &output.stdout, include_stdout_on_error);
        return Err(format!(
            "`{rendered}` exited with {}: {}",
            output.status, details
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|error| format!("`{rendered}` produced non-UTF-8 output: {error}"))
}

/// Like [`capture`], but logs the command and preserves stdout on failure.
///
/// Cargo emits JSON diagnostics on stdout when using `--message-format=json`,
/// so callers that parse command output need both streams when a build fails.
pub(crate) fn capture_logged(root: &Path, program: &str, args: &[&str]) -> Result<String, String> {
    println!("$ {}", render(program, args));
    capture_output(root, program, args, true, &[])
}

/// Returns whether a program can be started at all (used for install hints).
pub(crate) fn available(root: &Path, program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .current_dir(root)
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Every path tracked by git, relative to the repository root.
pub(crate) fn tracked_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let listing = capture(root, "git", &["ls-files", "-z"])?;
    Ok(listing
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(PathBuf::from)
        .collect())
}

fn render(program: &str, args: &[&str]) -> String {
    let mut rendered = String::from(program);
    for arg in args {
        rendered.push(' ');
        rendered.push_str(arg);
    }
    rendered
}

fn failure_details(stderr: &[u8], stdout: &[u8], include_stdout: bool) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if !include_stdout {
        return stderr.to_owned();
    }

    let stdout = String::from_utf8_lossy(stdout);
    let stdout = stdout.trim();
    match (stderr.is_empty(), stdout.is_empty()) {
        (false, false) => format!("{stderr}\n{stdout}"),
        (false, true) => stderr.to_owned(),
        (true, false) => stdout.to_owned(),
        (true, true) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::failure_details;

    #[test]
    fn logged_capture_preserves_stdout_diagnostics_on_failure() {
        let details = failure_details(
            b"cargo failed\n",
            br#"{"reason":"compiler-message","message":{"rendered":"linking failed"}}"#,
            true,
        );

        assert!(details.contains("cargo failed"));
        assert!(details.contains("compiler-message"));
        assert!(details.contains("linking failed"));
    }

    #[test]
    fn ordinary_capture_keeps_stderr_only_on_failure() {
        let details = failure_details(b"expected setup hint\n", b"ignored stdout\n", false);

        assert_eq!(details, "expected setup hint");
    }
}
