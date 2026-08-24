//! The TypeScript gates, delegated to the npm workspace root: `npm ci` for a
//! reproducible install, then `npm run check` (lint, build, typecheck, test,
//! pack inspection). On the verified `x86_64-unknown-linux-gnu` target, the
//! real `aizign` binary is built first and handed to the tests through
//! `AIZIGN_BINARY`, so the TypeScript reference client is exercised against
//! the storage/process boundary, not only the fake core. Other targets run
//! the fake-core suite.
//! Skipped with a notice when the workspace has no packages yet, so the
//! Rust-only path keeps working without Node.

use std::path::Path;

use crate::{cargo_build, report, shell};

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
    let binary = if cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    )) {
        Some(
            cargo_build::aizign_binary(root, false)?
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        println!(
            "unverified storage target: real-binary scenarios are covered by x86_64 GNU/Linux CI"
        );
        None
    };
    let mut environment = Vec::new();
    if let Some(binary) = &binary {
        environment.push(("AIZIGN_BINARY", binary.as_str()));
    }
    shell::run(root, "npm", &["ci", "--no-audit", "--no-fund"])?;
    shell::run_with_env(root, "npm", &["run", "check"], &environment)
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
