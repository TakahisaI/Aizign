//! Dependency direction and forbidden-import rules for the Rust workspace.
//!
//! The table below is the machine-readable twin of
//! `docs/architecture/dependency-rules.md`. Every workspace crate must be
//! registered here; an unregistered crate is a finding, which is what forces
//! a new crate to go through the dependency-rules document (and an ADR for
//! any new runtime dependency).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::audit::{display, read_text};
use crate::report::Findings;
use crate::shell;

struct CrateRule {
    name: &'static str,
    /// Workspace crates this crate may depend on at runtime.
    workspace: &'static [&'static str],
    /// Workspace crates this crate may additionally depend on in tests.
    dev_workspace: &'static [&'static str],
    /// External crates this crate may depend on (normal or dev).
    external: &'static [&'static str],
    /// Whether harness and provider names are banned from `src/`.
    harness_neutral: bool,
    /// Whether `src/` must stay free of I/O, clock, scheduling, and async:
    /// true for crates inside the functional core, false for the shell.
    shell_free: bool,
}

const RULES: &[CrateRule] = &[
    CrateRule {
        name: "aizign-core",
        workspace: &[],
        dev_workspace: &[],
        external: &[],
        harness_neutral: true,
        shell_free: true,
    },
    CrateRule {
        name: "aizign-engine",
        workspace: &["aizign-core"],
        dev_workspace: &["aizign-testkit"],
        external: &[],
        harness_neutral: true,
        shell_free: true,
    },
    CrateRule {
        name: "aizign-protocol",
        workspace: &["aizign-core"],
        dev_workspace: &["aizign-testkit"],
        external: &["serde", "serde_json"],
        harness_neutral: true,
        shell_free: true,
    },
    CrateRule {
        name: "aizign-store-jsonl",
        workspace: &["aizign-core", "aizign-engine"],
        dev_workspace: &["aizign-testkit"],
        external: &["serde", "serde_json", "sha2"],
        harness_neutral: true,
        shell_free: false,
    },
    CrateRule {
        name: "aizign-testkit",
        workspace: &["aizign-core", "aizign-engine", "aizign-protocol"],
        dev_workspace: &[],
        external: &["serde_json"],
        harness_neutral: true,
        shell_free: false,
    },
    CrateRule {
        name: "aizign-cli",
        workspace: &[
            "aizign-core",
            "aizign-engine",
            "aizign-protocol",
            "aizign-store-jsonl",
            "aizign-testkit",
        ],
        dev_workspace: &["aizign-testkit"],
        external: &["serde_json"],
        harness_neutral: true,
        shell_free: false,
    },
    CrateRule {
        name: "xtask",
        workspace: &[],
        dev_workspace: &[],
        external: &["serde_json"],
        harness_neutral: false,
        shell_free: false,
    },
];

/// Source patterns that must not appear in shell-free crates (core,
/// engine, protocol). `aizign-core` is additionally `no_std`, which makes
/// most of these impossible to compile; the scan still runs so the other
/// crates get the same rule.
const FORBIDDEN_PATHS: &[(&str, &str)] = &[
    ("std::fs", "filesystem access belongs to the shell"),
    ("std::process", "process control belongs to the shell"),
    ("std::net", "network access belongs to the shell"),
    ("std::env", "environment access belongs to the shell"),
    ("std::time", "time must be passed in as a bounded timestamp"),
    ("std::thread", "scheduling belongs to the shell"),
    ("std::sync::mpsc", "scheduling belongs to the shell"),
];

/// Identifier tokens that must not appear in code lines of harness-neutral
/// crates. (`unsafe` is already rejected by the compiler through
/// `forbid(unsafe_code)`, so it is not repeated here.)
const RUNTIME_TOKENS: &[(&str, &str)] = &[
    ("async", "no async runtime in the core"),
    ("await", "no async runtime in the core"),
    ("tokio", "no async runtime in the core"),
    ("futures", "no async runtime in the core"),
];

/// Harness and provider names that must not appear anywhere in
/// harness-neutral crates — code, comments, or docs.
const NAME_TOKENS: &[(&str, &str)] = &[
    ("dsh", "harness names stay in adapters"),
    ("codex", "provider names stay in adapters"),
    ("hermes", "harness names stay in adapters"),
    ("deepseek", "provider names stay in adapters"),
    ("openai", "provider names stay in adapters"),
    ("anthropic", "provider names stay in adapters"),
];

/// Crates whose source may not mention `serde` at all (ADR-0004). The
/// protocol and store crates own serialization and are exempt.
const NO_SERDE_CRATES: &[&str] = &["aizign-core", "aizign-engine"];

pub(crate) fn run(root: &Path, tracked: &[PathBuf]) -> Result<(), String> {
    let metadata = shell::capture(
        root,
        "cargo",
        &[
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--offline",
        ],
    )
    .or_else(|_| {
        shell::capture(
            root,
            "cargo",
            &["metadata", "--format-version", "1", "--no-deps"],
        )
    })?;
    let metadata: serde_json::Value =
        serde_json::from_str(&metadata).map_err(|error| format!("cargo metadata: {error}"))?;

    let packages = metadata["packages"]
        .as_array()
        .ok_or("cargo metadata: missing packages")?;
    let workspace_names: BTreeSet<&str> = packages
        .iter()
        .filter_map(|package| package["name"].as_str())
        .collect();

    let mut findings = Findings::default();

    for package in packages {
        let name = package["name"].as_str().unwrap_or("<unnamed>");
        let Some(rule) = RULES.iter().find(|rule| rule.name == name) else {
            findings.push(format!(
                "{name}: crate is not registered in xtask/src/audit/dependencies.rs \
                 and docs/architecture/dependency-rules.md"
            ));
            continue;
        };

        check_publish_disabled(name, package, &mut findings);
        check_declared_dependencies(rule, package, &workspace_names, &mut findings);

        if rule.harness_neutral || rule.shell_free {
            let manifest = package["manifest_path"].as_str().unwrap_or_default();
            let crate_dir = Path::new(manifest).parent().unwrap_or(Path::new("."));
            check_sources(root, crate_dir, rule, tracked, &mut findings)?;
        }
    }

    println!("{} workspace crate(s) checked", packages.len());
    findings.finish("dependency boundaries")
}

fn check_publish_disabled(name: &str, package: &serde_json::Value, findings: &mut Findings) {
    // `publish = false` is rendered as an empty registry list.
    let disabled = package["publish"].as_array().is_some_and(Vec::is_empty);
    if !disabled {
        findings.push(format!(
            "{name}: registry publication must stay disabled until v0.1 acceptance (ADR-0008); \
             set `publish.workspace = true`"
        ));
    }
}

fn check_declared_dependencies(
    rule: &CrateRule,
    package: &serde_json::Value,
    workspace_names: &BTreeSet<&str>,
    findings: &mut Findings,
) {
    let Some(dependencies) = package["dependencies"].as_array() else {
        return;
    };
    for dependency in dependencies {
        let dep_name = dependency["name"].as_str().unwrap_or("<unnamed>");
        let kind = dependency["kind"].as_str().unwrap_or("normal");
        let allowed = if workspace_names.contains(dep_name) {
            rule.workspace.contains(&dep_name)
                || (kind == "dev" && rule.dev_workspace.contains(&dep_name))
        } else {
            rule.external.contains(&dep_name)
        };
        if !allowed {
            findings.push(format!(
                "{}: {kind} dependency `{dep_name}` is not allowed by docs/architecture/dependency-rules.md",
                rule.name
            ));
        }
    }
}

fn check_sources(
    root: &Path,
    crate_dir: &Path,
    rule: &CrateRule,
    tracked: &[PathBuf],
    findings: &mut Findings,
) -> Result<(), String> {
    let src_dir = crate_dir.join("src");
    let src_prefix = src_dir.strip_prefix(root).unwrap_or(&src_dir).to_path_buf();
    let no_serde = NO_SERDE_CRATES.contains(&rule.name);

    for path in tracked {
        let is_rust = path.starts_with(&src_prefix)
            && path.extension().is_some_and(|extension| extension == "rs");
        if !is_rust {
            continue;
        }
        let Some(text) = read_text(root, path)? else {
            continue;
        };
        for (line_number, line) in text.lines().enumerate() {
            let line_number = line_number + 1;
            let location = format!("{}:{line_number}", display(path));
            let is_comment = line.trim_start().starts_with("//");
            let words = words(line);

            if rule.harness_neutral {
                for (token, reason) in NAME_TOKENS {
                    if words.iter().any(|word| word == token) {
                        findings.push(format!("{location}: `{token}` — {reason}"));
                    }
                }
            }
            if is_comment || !rule.shell_free {
                continue;
            }
            for (pattern, reason) in FORBIDDEN_PATHS {
                if line.contains(pattern) {
                    findings.push(format!("{location}: `{pattern}` — {reason}"));
                }
            }
            for (token, reason) in RUNTIME_TOKENS {
                if words.iter().any(|word| word == token) {
                    findings.push(format!("{location}: `{token}` — {reason}"));
                }
            }
            if no_serde && words.iter().any(|word| word == "serde") {
                findings.push(format!(
                    "{location}: `serde` — serialization is owned by the protocol and store crates (ADR-0004)"
                ));
            }
        }
    }
    Ok(())
}

/// Splits a line into lower-cased words, breaking on non-alphanumerics and
/// on camelCase boundaries, so `DshSession` yields `dsh` and `session`
/// while `friendship` stays one word.
fn words(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut previous_lower = false;
    for character in line.chars() {
        if character.is_alphanumeric() {
            if character.is_uppercase() && previous_lower && !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            current.extend(character.to_lowercase());
            previous_lower = character.is_lowercase() || character.is_numeric();
        } else {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            previous_lower = false;
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

#[cfg(test)]
mod tests {
    use super::words;

    #[test]
    fn splits_camel_case_and_keeps_plain_words() {
        assert_eq!(
            words("DshSession friendship"),
            ["dsh", "session", "friendship"]
        );
        assert_eq!(words("use std::fs;"), ["use", "std", "fs"]);
        assert_eq!(words("SHA256Digest"), ["sha256", "digest"]);
    }
}
