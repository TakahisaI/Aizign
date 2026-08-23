//! The TypeScript gates, delegated to the npm workspace root: `npm ci` for a
//! reproducible install, then `npm run check` (lint, build, typecheck, test,
//! pack inspection). The real `aizu` binary is built first and handed to the
//! tests through `AIZU_BINARY`, so the TypeScript reference client is
//! exercised against the real process boundary, not only the fake core.
//! Skipped with a notice when the workspace has no packages yet, so the
//! Rust-only path keeps working without Node.

use std::path::Path;

use crate::{report, shell};

const NPM_INSTALL_HINT: &str = "npm is required for `cargo xtask npm-check`; install the Node version \
    pinned in .node-version (see docs/development/getting-started.md)";

pub(crate) fn run(root: &Path) -> Result<(), String> {
    report::stage("npm check");
    if !has_workspace_packages(root) {
        println!("no packages under packages/ or adapters/ yet; skipping npm checks");
        return Ok(());
    }
    if !shell::available(root, "npm", &["--version"]) {
        return Err(NPM_INSTALL_HINT.to_string());
    }
    shell::run(root, "cargo", &["build", "--quiet", "-p", "aizu-cli"])?;
    let binary = root.join("target").join("debug").join("aizu");
    let binary = binary.to_string_lossy().into_owned();
    shell::run(root, "npm", &["ci", "--no-audit", "--no-fund"])?;
    shell::run_with_env(
        root,
        "npm",
        &["run", "check"],
        &[("AIZU_BINARY", binary.as_str())],
    )
}

fn has_workspace_packages(root: &Path) -> bool {
    ["packages", "adapters"].iter().any(|container| {
        std::fs::read_dir(root.join(container)).is_ok_and(|entries| {
            entries
                .flatten()
                .any(|entry| entry.path().join("package.json").is_file())
        })
    })
}
