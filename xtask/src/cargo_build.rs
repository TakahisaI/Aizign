//! Build helpers that obtain executable paths from Cargo artifact messages.

use std::path::{Path, PathBuf};

use crate::shell;

/// Builds `aizign-cli` and returns the executable Cargo reports producing.
///
/// Reading the `compiler-artifact` message keeps this correct when a developer
/// sets `CARGO_TARGET_DIR`, `build.target-dir`, or a configured build target.
pub(crate) fn aizign_binary(root: &Path, frozen: bool) -> Result<PathBuf, String> {
    let mut args = vec!["build"];
    if frozen {
        args.push("--frozen");
    }
    args.extend([
        "--quiet",
        "--message-format=json",
        "--package",
        "aizign-cli",
    ]);
    let messages = shell::capture_logged(root, "cargo", &args)?;
    let executable = executable_from_messages(root, &messages)?;
    println!("aizign binary: {}", executable.display());
    Ok(executable)
}

fn executable_from_messages(root: &Path, messages: &str) -> Result<PathBuf, String> {
    let mut executable = None;
    for line in messages.lines() {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if message.get("reason").and_then(serde_json::Value::as_str) != Some("compiler-artifact") {
            continue;
        }
        let Some(target) = message.get("target") else {
            continue;
        };
        let is_aizign_binary = target.get("name").and_then(serde_json::Value::as_str)
            == Some("aizign")
            && target
                .get("kind")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|kinds| kinds.iter().any(|kind| kind.as_str() == Some("bin")));
        if !is_aizign_binary {
            continue;
        }
        if let Some(path) = message
            .get("executable")
            .and_then(serde_json::Value::as_str)
        {
            executable = Some(PathBuf::from(path));
        }
    }

    let executable = executable
        .ok_or_else(|| "cargo build did not report the `aizign` executable artifact".to_owned())?;
    Ok(if executable.is_absolute() {
        executable
    } else {
        root.join(executable)
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::executable_from_messages;

    #[test]
    fn selects_the_reported_aizign_binary_instead_of_a_fixed_target_path() {
        let messages = concat!(
            r#"{"reason":"compiler-artifact","target":{"kind":["lib"],"name":"aizign_protocol"},"executable":null}"#,
            "\n",
            r#"{"reason":"compiler-artifact","target":{"kind":["bin"],"name":"aizign"},"executable":"/tmp/custom-target/debug/aizign"}"#,
            "\n",
            r#"{"reason":"build-finished","success":true}"#,
        );
        let executable = executable_from_messages(Path::new("/repo"), messages).unwrap();
        assert_eq!(executable, Path::new("/tmp/custom-target/debug/aizign"));
    }

    #[test]
    fn rejects_messages_without_the_aizign_executable() {
        let error = executable_from_messages(
            Path::new("/repo"),
            r#"{"reason":"build-finished","success":true}"#,
        )
        .unwrap_err();
        assert!(error.contains("did not report"));
    }
}
