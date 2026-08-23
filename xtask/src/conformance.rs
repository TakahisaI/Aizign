//! Structural validation of the language-neutral fixtures under
//! `spec/conformance`.
//!
//! Fixtures are shared by the Rust and TypeScript protocol implementations,
//! so this command only checks what is true regardless of language:
//!
//! - `spec/conformance/valid/**` holds JSON documents that every decoder
//!   must accept;
//! - `spec/conformance/invalid/**` holds inputs that every decoder must
//!   reject (they may be malformed on purpose, so only their presence and
//!   naming are checked here).
//!
//! Running the fixtures through the actual decoders is the job of the
//! protocol crates and packages; they read the same files.

use std::fs;
use std::path::{Path, PathBuf};

use crate::report::{self, Findings};

const FIXTURE_ROOT: &str = "spec/conformance";

pub(crate) fn run(root: &Path) -> Result<(), String> {
    report::stage("conformance fixtures");
    let fixture_root = root.join(FIXTURE_ROOT);
    if !fixture_root.is_dir() {
        println!(
            "{FIXTURE_ROOT}/ does not exist yet; no fixtures to validate \
             (added by the language-neutral conformance fixtures issue)"
        );
        return Ok(());
    }

    let mut findings = Findings::default();
    let valid = collect(&fixture_root.join("valid"), &mut findings)?;
    let invalid = collect(&fixture_root.join("invalid"), &mut findings)?;

    for path in &valid {
        let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
        if let Err(error) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            findings.push(format!(
                "{}: valid fixture is not JSON: {error}",
                relative(root, path)
            ));
        }
    }

    println!(
        "{} valid, {} invalid fixture(s)",
        valid.len(),
        invalid.len()
    );
    if valid.is_empty() && invalid.is_empty() {
        findings.push(format!("{FIXTURE_ROOT}/ exists but contains no fixtures"));
    }
    findings.finish("conformance")
}

fn collect(dir: &Path, findings: &mut Findings) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    if !dir.is_dir() {
        findings.push(format!("missing fixture directory {}", dir.display()));
        return Ok(files);
    }
    walk(dir, &mut files)?;
    for path in &files {
        let is_json = path
            .extension()
            .is_some_and(|extension| extension == "json");
        if !is_json {
            findings.push(format!(
                "{}: fixtures must use the .json extension",
                path.display()
            ));
        }
    }
    files.sort();
    Ok(files)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", dir.display()))?;
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
}
