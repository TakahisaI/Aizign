//! Secrets, private paths, and legacy references must never reach the
//! tracked tree (SECURITY.md, ADR-0006).
//!
//! This file defines the patterns and is therefore the one file exempt from
//! the content scan.

use std::path::{Path, PathBuf};

use crate::audit::{display, read_text};
use crate::report::Findings;

/// Files whose content is not scanned (they define the rules).
const EXEMPT_CONTENT: &[&str] = &["xtask/src/audit/secrets.rs"];

/// Token prefixes followed by at least `min_tail` alphanumeric characters.
const TOKEN_PREFIXES: &[(&str, usize, &str)] = &[
    ("ghp_", 20, "GitHub personal access token"),
    ("gho_", 20, "GitHub OAuth token"),
    ("ghu_", 20, "GitHub user-to-server token"),
    ("ghs_", 20, "GitHub server-to-server token"),
    ("ghr_", 20, "GitHub refresh token"),
    ("github_pat_", 20, "GitHub fine-grained token"),
    ("sk-ant-", 20, "Anthropic API key"),
    ("sk-proj-", 20, "OpenAI project key"),
    ("AKIA", 16, "AWS access key id"),
    ("xoxb-", 10, "Slack bot token"),
    ("xoxp-", 10, "Slack user token"),
    ("glpat-", 20, "GitLab personal access token"),
    ("npm_", 36, "npm access token"),
];

/// Literal substrings that are always findings.
const LITERALS: &[(&str, &str)] = &[
    ("PRIVATE KEY-----", "private key material"),
    ("_authToken", "registry auth token"),
    ("/Users/", "macOS home directory path"),
    ("/home/", "Linux home directory path"),
    ("C:\\Users\\", "Windows home directory path"),
    (
        "dev-orchestration-lab",
        "legacy private repository name (ADR-0006)",
    ),
];

/// Tracked paths that must not exist.
const FORBIDDEN_BASENAMES: &[&str] = &[
    ".env",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    ".DS_Store",
    ".npmrc.local",
];
const FORBIDDEN_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "jks", "keystore"];
const FORBIDDEN_COMPONENTS: &[&str] = &[
    "node_modules",
    "target",
    ".aizu-state",
    ".aizign-state",
    "runtime",
];

pub(crate) fn run(root: &Path, tracked: &[PathBuf]) -> Result<(), String> {
    let mut findings = Findings::default();

    for path in tracked {
        check_path(path, &mut findings);
        let rendered = display(path);
        if EXEMPT_CONTENT.contains(&rendered.as_str()) {
            continue;
        }
        let Some(text) = read_text(root, path)? else {
            continue;
        };
        for (line_number, line) in text.lines().enumerate() {
            let location = format!("{rendered}:{}", line_number + 1);
            check_line(&location, line, &mut findings);
        }
    }

    println!("{} tracked file(s) scanned", tracked.len());
    findings.finish("secrets and private paths")
}

fn check_path(path: &Path, findings: &mut Findings) {
    let rendered = display(path);
    let basename = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    if FORBIDDEN_BASENAMES.contains(&basename.as_str()) || basename.starts_with(".env.") {
        findings.push(format!("{rendered}: file name must not be tracked"));
    }
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().into_owned())
        .unwrap_or_default();
    if FORBIDDEN_EXTENSIONS.contains(&extension.as_str()) {
        findings.push(format!(
            "{rendered}: `.{extension}` files must not be tracked"
        ));
    }
    for component in path.components() {
        let component = component.as_os_str().to_string_lossy();
        if FORBIDDEN_COMPONENTS.contains(&component.as_ref()) {
            findings.push(format!("{rendered}: `{component}/` must not be tracked"));
        }
    }
}

fn check_line(location: &str, line: &str, findings: &mut Findings) {
    for (literal, description) in LITERALS {
        if line.contains(literal) {
            findings.push(format!("{location}: {description} (`{literal}`)"));
        }
    }
    for (prefix, min_tail, description) in TOKEN_PREFIXES {
        let mut search = line;
        while let Some(index) = search.find(prefix) {
            let tail = &search[index + prefix.len()..];
            let run = tail
                .chars()
                .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
                .count();
            if run >= *min_tail {
                findings.push(format!("{location}: possible {description} (`{prefix}…`)"));
                break;
            }
            search = &search[index + prefix.len()..];
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{check_line, check_path};
    use crate::report::Findings;

    #[test]
    fn flags_tokens_only_with_a_plausible_tail() {
        let mut findings = Findings::default();
        check_line(
            "f:1",
            "token = ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            &mut findings,
        );
        assert_eq!(findings.len(), 1);

        let mut findings = Findings::default();
        check_line(
            "f:1",
            "env var npm_execpath is read by the script",
            &mut findings,
        );
        assert!(findings.is_empty());
    }

    #[test]
    fn flags_home_directories() {
        let mut findings = Findings::default();
        check_line("f:1", "see /Users/someone/work", &mut findings);
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn flags_the_legacy_state_directory() {
        let mut findings = Findings::default();
        check_path(Path::new("foo/.aizu-state/workflow.jsonl"), &mut findings);
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn flags_the_current_state_directory() {
        let mut findings = Findings::default();
        check_path(Path::new("foo/.aizign-state/workflow.jsonl"), &mut findings);
        assert_eq!(findings.len(), 1);
    }
}
