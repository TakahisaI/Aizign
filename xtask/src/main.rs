//! Repository tooling for Aizign, invoked as `cargo xtask <command>`.
//!
//! `xtask` is not a published artifact. It exists so that every check a
//! pull request must pass has exactly one entry point (`cargo xtask check`)
//! that works identically on a developer machine and in CI.

mod audit;
mod conformance;
mod npm_check;
mod quick;
mod report;
mod rust_check;
mod shell;

use std::path::Path;
use std::process::ExitCode;

const USAGE: &str = "\
usage: cargo xtask <command>

commands:
  check          run every pull-request gate (rust-check, npm-check, conformance, public-audit, whitespace)
  quick [profile]
                 run network-free cached checks (default, protocol, adapter-dsh)
  rust-check     cargo fmt / clippy / test / doc / deny
  npm-check      npm ci + npm run check (lint, build, typecheck, test, pack) for the TypeScript workspace
  conformance    validate the language-neutral fixtures under spec/conformance
  public-audit   dependency boundaries, forbidden imports, secrets and private paths,
                 closed package exports, entry documents, documentation links
  whitespace     git diff --check over the whole tree (trailing whitespace, missing final newline)
  help           print this message

quick profiles (network-free; existing caches and node_modules only):
  default        fmt -> Rust workspace check/library tests -> TypeScript build/lint/typecheck
  protocol       default -> shared fixtures -> Rust/TypeScript protocol, journal, and schema tests
  adapter-dsh    default -> fresh aizign-cli build -> targeted adapter lint/typecheck/tests
                 with adapter-testkit fake-core and real-binary round trips
Run `cargo xtask quick --help` for the exact order, guarantees, and exclusions.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = shell::repository_root();

    let outcome = match args.first().map(String::as_str) {
        Some("check") => check(&root),
        Some("quick") => quick::run(&root, &args[1..]),
        Some("rust-check") => rust_check::run(&root),
        Some("npm-check") => npm_check::run(&root),
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
    npm_check::run(root)?;
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
