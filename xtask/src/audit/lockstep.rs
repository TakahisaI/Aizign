//! Version lockstep (#33): every crate and npm package carries the one
//! workspace version, and internal `@aizign/*` dependencies pin exactly it.
//! Protocol and journal schema versions evolve independently; package
//! versions do not (ADR-0008). The release workflow checks only the root
//! versions against the tag, so this audit is what makes a partial bump
//! visible in every CI run.

use std::path::{Path, PathBuf};

use crate::audit::{display, read_text};
use crate::report::Findings;

pub(crate) fn run(root: &Path, tracked: &[PathBuf]) -> Result<(), String> {
    let mut findings = Findings::default();
    let Some(anchor) = workspace_version(root, &mut findings)? else {
        return findings.finish("version lockstep");
    };
    println!("workspace version {anchor}");

    let mut checked = 0;
    for path in tracked {
        let Some(name) = path.file_name().map(|name| name.to_string_lossy()) else {
            continue;
        };
        let Some(text) = read_text(root, path)? else {
            continue;
        };
        let rendered = display(path);
        match name.as_ref() {
            "Cargo.toml" if path.components().count() > 1 => {
                checked += 1;
                check_member_cargo(&rendered, &text, &mut findings);
            }
            "Cargo.toml" => {
                checked += 1;
                check_root_cargo(&rendered, &text, &anchor, &mut findings);
            }
            "package.json" => {
                checked += 1;
                check_package_json(&rendered, &text, &anchor, &mut findings);
            }
            _ => {}
        }
    }

    println!("{checked} manifest(s) checked");
    findings.finish("version lockstep")
}

/// The single source of the lockstep version: `[workspace.package] version`.
fn workspace_version(root: &Path, findings: &mut Findings) -> Result<Option<String>, String> {
    let Some(text) = read_text(root, Path::new("Cargo.toml"))? else {
        findings.push("Cargo.toml: missing".to_owned());
        return Ok(None);
    };
    let version = section_value(&text, "[workspace.package]", "version");
    if version.is_none() {
        findings.push("Cargo.toml: `[workspace.package]` must set `version`".to_owned());
    }
    Ok(version)
}

/// A member crate must inherit the workspace version, never declare its own.
fn check_member_cargo(rendered: &str, text: &str, findings: &mut Findings) {
    if !text
        .lines()
        .any(|line| line.trim() == "version.workspace = true")
    {
        findings.push(format!(
            "{rendered}: `[package]` must set `version.workspace = true`"
        ));
    }
    if section_value(text, "[package]", "version").is_some() {
        findings.push(format!(
            "{rendered}: crates must not declare their own `version`"
        ));
    }
}

/// `[workspace.dependencies]` path entries must pin the workspace version.
fn check_root_cargo(rendered: &str, text: &str, anchor: &str, findings: &mut Findings) {
    for line in section_lines(text, "[workspace.dependencies]") {
        let Some((name, rest)) = line.split_once('=') else {
            continue;
        };
        if !rest.contains("path") {
            continue;
        }
        let name = name.trim();
        match value_in_braces(rest, "version") {
            Some(version) if version == anchor => {}
            Some(version) => findings.push(format!(
                "{rendered}: `{name}` pins version {version}; the workspace version is {anchor}"
            )),
            None => findings.push(format!(
                "{rendered}: `{name}` must pin `version = \"{anchor}\"` next to its path"
            )),
        }
    }
}

/// Package version and every internal `@aizign/*` dependency must equal the anchor.
fn check_package_json(rendered: &str, text: &str, anchor: &str, findings: &mut Findings) {
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(text) else {
        return; // The package-manifest audit reports invalid JSON.
    };
    match manifest["version"].as_str() {
        Some(version) if version == anchor => {}
        Some(version) => findings.push(format!(
            "{rendered}: version {version} is not the workspace version {anchor}"
        )),
        None => findings.push(format!("{rendered}: `version` must be \"{anchor}\"")),
    }
    for table in ["dependencies", "devDependencies", "peerDependencies"] {
        let Some(entries) = manifest[table].as_object() else {
            continue;
        };
        for (name, value) in entries {
            if !name.starts_with("@aizign/") {
                continue;
            }
            if value.as_str() != Some(anchor) {
                findings.push(format!(
                    "{rendered}: {table}.{name} must pin exactly \"{anchor}\", found {value}"
                ));
            }
        }
    }
}

/// The value of `key = "..."` inside one TOML section (top-level lines only).
fn section_value(text: &str, section: &str, key: &str) -> Option<String> {
    for line in section_lines(text, section) {
        if let Some(rest) = line.strip_prefix(key)
            && let Some(rest) = rest.trim_start().strip_prefix('=')
        {
            return quoted(rest);
        }
    }
    None
}

/// The lines of one TOML section, up to the next section header.
fn section_lines<'a>(text: &'a str, section: &str) -> Vec<&'a str> {
    let mut inside = false;
    let mut lines = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            inside = trimmed == section;
            continue;
        }
        if inside && !trimmed.is_empty() && !trimmed.starts_with('#') {
            lines.push(trimmed);
        }
    }
    lines
}

/// The value of `key = "..."` inside an inline table like `{ path = "…", version = "…" }`.
fn value_in_braces(rest: &str, key: &str) -> Option<String> {
    let inner = rest.split_once('{')?.1;
    for part in inner.trim_end().trim_end_matches('}').split(',') {
        let (name, value) = part.split_once('=')?;
        if name.trim() == key {
            return quoted(value);
        }
    }
    None
}

/// The contents of the first double-quoted string in `rest`.
fn quoted(rest: &str) -> Option<String> {
    let rest = rest.trim();
    let rest = rest.strip_prefix('"')?;
    Some(rest.split('"').next()?.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = r#"
[workspace.package]
version = "0.1.0"

[workspace.dependencies]
aizign-core = { path = "crates/aizign-core", version = "0.1.0" }
serde = { version = "1.0.229", default-features = false }
"#;

    #[test]
    fn reads_the_workspace_version_and_accepts_matching_pins() {
        assert_eq!(
            section_value(ROOT, "[workspace.package]", "version").as_deref(),
            Some("0.1.0")
        );
        let mut findings = Findings::default();
        check_root_cargo("Cargo.toml", ROOT, "0.1.0", &mut findings);
        assert!(findings.finish("t").is_ok());
    }

    #[test]
    fn flags_a_drifted_internal_pin() {
        let mut findings = Findings::default();
        check_root_cargo("Cargo.toml", ROOT, "0.2.0", &mut findings);
        assert!(findings.finish("t").is_err());

        let mut findings = Findings::default();
        check_package_json(
            "packages/x/package.json",
            r#"{ "version": "0.1.0", "dependencies": { "@aizign/protocol": "^0.1.0" } }"#,
            "0.1.0",
            &mut findings,
        );
        assert!(findings.finish("t").is_err(), "ranges are not exact pins");
    }

    #[test]
    fn member_crates_must_inherit_the_workspace_version() {
        let mut findings = Findings::default();
        check_member_cargo(
            "crates/x/Cargo.toml",
            "[package]\nname = \"x\"\nversion.workspace = true\n",
            &mut findings,
        );
        assert!(findings.finish("t").is_ok());

        let mut findings = Findings::default();
        check_member_cargo(
            "crates/x/Cargo.toml",
            "[package]\nname = \"x\"\nversion = \"0.1.0\"\n",
            &mut findings,
        );
        assert!(findings.finish("t").is_err());
    }
}
