//! Repository tooling for Aizu, invoked as `cargo xtask <command>`.
//!
//! `xtask` is not a published artifact. It exists so that every check a
//! pull request must pass has exactly one entry point (`cargo xtask check`)
//! that works identically on a developer machine and in CI.

mod audit;
mod conformance;
mod report;
mod rust_check;
mod shell;

use std::path::Path;
use std::process::ExitCode;

const USAGE: &str = "\
usage: cargo xtask <command>

commands:
  check          run every pull-request gate (rust-check, conformance, public-audit, git diff --check)
  rust-check     cargo fmt / clippy / test / doc / deny
  conformance    validate the language-neutral fixtures under spec/conformance
  public-audit   dependency boundaries, forbidden imports, secrets and private paths,
                 closed package exports, entry documents, documentation links
  whitespace     git diff --check over the whole tree (trailing whitespace, missing final newline)
  help           print this message
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = shell::repository_root();

    let outcome = match args.first().map(String::as_str) {
        Some("check") => check(&root),
        Some("rust-check") => rust_check::run(&root),
        Some("conformance") => conformance::run(&root),
        Some("public-audit") => audit::run(&root),
        Some("whitespace") => whitespace(&root),
        Some("help" | "--help" | "-h") | None => {
            print!("{USAGE}");
            Ok(())
        }
        Some(other) => Err(format!("unknown command `{other}`\n\n{USAGE}")),
    };

    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Runs every gate a pull request must pass, in the order CI runs them.
fn check(root: &Path) -> Result<(), String> {
    rust_check::run(root)?;
    conformance::run(root)?;
    audit::run(root)?;
    whitespace(root)?;
    println!("\nall checks passed");
    Ok(())
}

/// Whitespace errors over the whole working tree, not just the last diff:
/// diffing against the empty tree makes `git diff --check` inspect every
/// tracked file, so the result is the same locally and in CI.
fn whitespace(root: &Path) -> Result<(), String> {
    report::stage("git diff --check (whole tree)");
    let empty_tree = shell::capture(root, "git", &["hash-object", "-t", "tree", "/dev/null"])?;
    shell::run(root, "git", &["diff", "--check", empty_tree.trim()])
}
