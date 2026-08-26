//! Every crate, package, and adapter carries a `README.md` with responsibilities
//! and invariants (ADR-0005). Every adapter and the named crates below also carry
//! an `AGENTS.md` that serves as a non-authoritative navigation entry document.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::report::Findings;

/// Directories (depth two) whose children are crates or packages.
const CONTAINERS: &[&str] = &["crates", "packages", "adapters"];

/// Crates that must also carry a non-authoritative navigation `AGENTS.md`;
/// every adapter must as well.
const AGENTS_REQUIRED: &[&str] = &["crates/aizign-core", "crates/aizign-engine"];

pub(crate) fn run(root: &Path, tracked: &[PathBuf]) -> Result<(), String> {
    let mut findings = Findings::default();
    let mut units = BTreeSet::new();

    for path in tracked {
        let mut components = path.components();
        let (Some(container), Some(unit)) = (components.next(), components.next()) else {
            continue;
        };
        let container = container.as_os_str().to_string_lossy();
        if CONTAINERS.contains(&container.as_ref()) && components.next().is_some() {
            units.insert(format!(
                "{container}/{}",
                unit.as_os_str().to_string_lossy()
            ));
        }
    }

    for unit in &units {
        if !root.join(unit).join("README.md").is_file() {
            findings.push(format!("{unit}: missing README.md"));
        }
        let needs_agents =
            unit.starts_with("adapters/") || AGENTS_REQUIRED.contains(&unit.as_str());
        if needs_agents && !root.join(unit).join("AGENTS.md").is_file() {
            findings.push(format!("{unit}: missing AGENTS.md"));
        }
    }

    println!("{} unit(s) checked", units.len());
    findings.finish("entry documents")
}
