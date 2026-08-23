//! The Rust gates: format, lint, test, documentation, and dependency policy.

use std::path::Path;

use crate::{report, shell};

const DENY_INSTALL_HINT: &str = "cargo-deny is required for `cargo xtask rust-check`.\n\
    install it with `cargo install cargo-deny --locked` (CI uses the pinned cargo-deny action)";

pub(crate) fn run(root: &Path) -> Result<(), String> {
    report::stage("cargo fmt");
    shell::run(root, "cargo", &["fmt", "--all", "--check"])?;

    report::stage("cargo clippy");
    shell::run(
        root,
        "cargo",
        &[
            "clippy",
            "--workspace",
            "--all-targets",
            "--all-features",
            "--",
            "-D",
            "warnings",
        ],
    )?;

    report::stage("cargo test");
    shell::run(root, "cargo", &["test", "--workspace"])?;

    report::stage("cargo doc");
    shell::run_with_env(
        root,
        "cargo",
        &["doc", "--workspace", "--no-deps"],
        &[("RUSTDOCFLAGS", "-D warnings")],
    )?;

    report::stage("cargo deny");
    if !shell::available(root, "cargo", &["deny", "--version"]) {
        return Err(DENY_INSTALL_HINT.to_string());
    }
    shell::run(root, "cargo", &["deny", "check"])?;

    // Package contents inspection: every crate must package cleanly even
    // though registry publication stays disabled (release gate, ADR-0008).
    report::stage("cargo package --list");
    shell::run(
        root,
        "cargo",
        &[
            "package",
            "--list",
            "--workspace",
            "--allow-dirty",
            "--quiet",
        ],
    )?;

    Ok(())
}
