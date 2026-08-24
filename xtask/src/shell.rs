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
    let rendered = render(program, args);
    let output = Command::new(program)
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| format!("failed to start `{rendered}`: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "`{rendered}` exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|error| format!("`{rendered}` produced non-UTF-8 output: {error}"))
}

/// Like [`capture`], but logs the command before running it.
pub(crate) fn capture_logged(root: &Path, program: &str, args: &[&str]) -> Result<String, String> {
    println!("$ {}", render(program, args));
    capture(root, program, args)
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
