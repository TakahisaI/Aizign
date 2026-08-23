//! `cargo xtask public-audit`: the checks that keep the repository
//! publishable and its boundaries intact.
//!
//! Each sub-audit is independent and reports its own findings; the command
//! fails if any of them found something. The rules they enforce are
//! documented in `docs/architecture/dependency-rules.md`,
//! `docs/architecture/data-boundary.md`, and `SECURITY.md`. When a rule
//! changes, update the document and the audit in the same pull request.

mod dependencies;
mod entry_docs;
mod links;
mod lockstep;
mod packages;
mod secrets;

use std::path::{Path, PathBuf};

use crate::{report, shell};

/// One sub-audit: receives the repository root and the tracked paths.
type Audit = fn(&Path, &[PathBuf]) -> Result<(), String>;

pub(crate) fn run(root: &Path) -> Result<(), String> {
    let tracked = shell::tracked_files(root)?;
    let mut failures = Vec::new();

    let audits: [(&str, Audit); 6] = [
        ("dependency boundaries", dependencies::run),
        ("secrets and private paths", secrets::run),
        ("package manifests", packages::run),
        ("version lockstep", lockstep::run),
        ("entry documents", entry_docs::run),
        ("documentation links", links::run),
    ];

    for (name, audit) in audits {
        report::stage(&format!("public-audit: {name}"));
        if let Err(message) = audit(root, &tracked) {
            println!("{message}");
            failures.push(name);
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("public-audit failed: {}", failures.join(", ")))
    }
}

/// Reads a tracked file as UTF-8 text, or `None` if it is not text.
fn read_text(root: &Path, path: &Path) -> Result<Option<String>, String> {
    let bytes =
        std::fs::read(root.join(path)).map_err(|error| format!("{}: {error}", path.display()))?;
    if bytes.contains(&0) {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}

/// Path rendered with `/` separators, for stable output across platforms.
fn display(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}
