//! Network-free development checks that reuse the existing Cargo cache and
//! npm installation. These profiles intentionally complement rather than
//! replace the full `cargo xtask check` pull-request gate.

use std::path::Path;

use crate::{cargo_build, conformance, report, shell};

pub(crate) const USAGE: &str = "\
usage: cargo xtask quick [profile]

profiles (run in the listed order):
  default (or omitted)
    1. verify the existing npm installation (no install)
    2. cargo fmt --all --check
    3. cargo check --frozen --workspace --all-targets --all-features
    4. cargo test --frozen --workspace --lib
    5. npm run build
    6. npm run lint
    7. npm run typecheck
    Guarantees repository-wide Rust compilation and library unit tests plus
    TypeScript build, lint, and type checking against the installed dependencies.

  protocol
    Run default, then structural conformance validation, Rust protocol and
    journal tests, TypeScript protocol tests, and schema/example validation.
    Guarantees the shared protocol and journal fixture acceptance sets are checked.

  adapter-dsh
    Run default (including adapter lint/typecheck), then always rebuild aizign-cli,
    run targeted DSH lint/typecheck, and run protocol, adapter-testkit, and DSH
    adapter tests with that real binary.
    Guarantees the DSH fake-core and freshly built real-binary round trips are checked.

All profiles are offline, require an existing node_modules installation, and
must not change tracked files. They do not run npm ci, cargo doc, cargo deny,
package inspection, public audit, full workspace integration tests, or clean-install
checks. Success is not pull-request or release readiness; run `cargo xtask check`
before push or PR.
";

const NPM_SETUP_HINT: &str = "quick checks require the existing npm workspace dependencies, \
    but {problem}. Run `npm ci --no-audit --no-fund` once (or run \
    `cargo xtask check` for the full setup and PR gate), then retry. \
    `cargo xtask quick` never installs dependencies";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Profile {
    Default,
    Protocol,
    AdapterDsh,
}

impl Profile {
    fn parse(args: &[String]) -> Result<Option<Self>, String> {
        match args {
            [] => Ok(Some(Self::Default)),
            [profile] if profile == "default" => Ok(Some(Self::Default)),
            [profile] if profile == "protocol" => Ok(Some(Self::Protocol)),
            [profile] if profile == "adapter-dsh" => Ok(Some(Self::AdapterDsh)),
            [help] if matches!(help.as_str(), "help" | "--help" | "-h") => Ok(None),
            [profile] => Err(format!("unknown quick profile `{profile}`\n\n{USAGE}")),
            _ => Err(format!("quick accepts at most one profile\n\n{USAGE}")),
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Protocol => "protocol",
            Self::AdapterDsh => "adapter-dsh",
        }
    }
}

pub(crate) fn run(root: &Path, args: &[String]) -> Result<(), String> {
    let Some(profile) = Profile::parse(args)? else {
        print!("{USAGE}");
        return Ok(());
    };

    ensure_dependencies(root)?;
    let tracked_before = tracked_changes(root)?;
    let outcome = run_profile(root, profile);
    let tracked_after = tracked_changes(root)?;

    if tracked_before != tracked_after {
        return Err(match outcome {
            Ok(()) => "quick checks changed tracked files; inspect and restore those changes before continuing"
                .to_owned(),
            Err(error) => format!(
                "{error}\nquick checks also changed tracked files; inspect and restore those changes before continuing"
            ),
        });
    }
    outcome?;

    println!(
        "\nquick {} checks passed (run `cargo xtask check` before push or PR)",
        profile.name()
    );
    Ok(())
}

fn run_profile(root: &Path, profile: Profile) -> Result<(), String> {
    run_default(root)?;
    match profile {
        Profile::Default => Ok(()),
        Profile::Protocol => run_protocol(root),
        Profile::AdapterDsh => run_adapter_dsh(root),
    }
}

fn run_default(root: &Path) -> Result<(), String> {
    report::stage("quick/default: cargo fmt");
    shell::run(root, "cargo", &["fmt", "--all", "--check"])?;

    report::stage("quick/default: Rust workspace check (frozen cache)");
    shell::run(
        root,
        "cargo",
        &[
            "check",
            "--frozen",
            "--workspace",
            "--all-targets",
            "--all-features",
        ],
    )?;

    report::stage("quick/default: Rust workspace library tests (frozen cache)");
    shell::run(root, "cargo", &["test", "--frozen", "--workspace", "--lib"])?;

    run_npm(root, "quick/default: TypeScript build", &["run", "build"])?;
    run_npm(root, "quick/default: TypeScript lint", &["run", "lint"])?;
    run_npm(
        root,
        "quick/default: TypeScript typecheck",
        &["run", "typecheck"],
    )
}

fn run_protocol(root: &Path) -> Result<(), String> {
    conformance::run(root)?;

    report::stage("quick/protocol: Rust protocol and journal tests");
    shell::run(
        root,
        "cargo",
        &[
            "test",
            "--frozen",
            "-p",
            "aizign-protocol",
            "-p",
            "aizign-store-jsonl",
        ],
    )?;

    run_npm(
        root,
        "quick/protocol: TypeScript protocol tests",
        &["test", "-w", "@aizign/protocol"],
    )?;
    run_npm(
        root,
        "quick/protocol: schema and example tests",
        &["run", "test:spec"],
    )
}

fn run_adapter_dsh(root: &Path) -> Result<(), String> {
    let binary = if cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu"
    )) {
        report::stage("quick/adapter-dsh: rebuild real aizign binary");
        Some(
            cargo_build::aizign_binary(root, true)?
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        report::stage("quick/adapter-dsh: fake core on unsupported storage host");
        None
    };
    let mut env = Vec::new();
    if let Some(binary) = &binary {
        env.push(("AIZIGN_BINARY", binary.as_str()));
    }

    run_npm(
        root,
        "quick/adapter-dsh: targeted lint",
        &["exec", "--", "biome", "ci", "adapters/dsh"],
    )?;
    run_npm(
        root,
        "quick/adapter-dsh: targeted typecheck",
        &["run", "typecheck", "-w", "@aizign/adapter-dsh"],
    )?;
    run_npm_with_env(
        root,
        "quick/adapter-dsh: reference protocol tests",
        &["test", "-w", "@aizign/protocol"],
        &env,
    )?;
    run_npm_with_env(
        root,
        "quick/adapter-dsh: adapter testkit (fake and real binary)",
        &["test", "-w", "@aizign/adapter-testkit"],
        &env,
    )?;
    run_npm_with_env(
        root,
        "quick/adapter-dsh: DSH adapter tests (fake and real binary)",
        &["test", "-w", "@aizign/adapter-dsh"],
        &env,
    )
}

fn run_npm(root: &Path, stage: &str, args: &[&str]) -> Result<(), String> {
    run_npm_with_env(root, stage, args, &[])
}

fn run_npm_with_env(
    root: &Path,
    stage: &str,
    args: &[&str],
    extra_env: &[(&str, &str)],
) -> Result<(), String> {
    report::stage(stage);
    let mut env = vec![("NPM_CONFIG_OFFLINE", "true")];
    env.extend_from_slice(extra_env);
    shell::run_with_env(root, "npm", args, &env)
}

fn ensure_dependencies(root: &Path) -> Result<(), String> {
    if !shell::available(root, "node", &["--version"]) {
        return Err(
            "Node.js is required for quick checks. Install the version pinned in \
            `.node-version` (see docs/development/getting-started.md)"
                .to_owned(),
        );
    }
    if !shell::available(root, "npm", &["--version"]) {
        return Err(
            "npm is required for quick checks. Install the version pinned in `package.json` \
            (see docs/development/getting-started.md)"
                .to_owned(),
        );
    }

    if !root.join("node_modules/.package-lock.json").is_file() {
        return Err(
            NPM_SETUP_HINT.replace("{problem}", "node_modules/.package-lock.json is missing")
        );
    }
    if shell::capture(root, "npm", &["ls", "--all", "--offline"]).is_err() {
        return Err(NPM_SETUP_HINT.replace(
            "{problem}",
            "the installed npm dependency tree is incomplete",
        ));
    }
    Ok(())
}

fn tracked_changes(root: &Path) -> Result<String, String> {
    let unstaged = shell::capture(root, "git", &["diff", "--binary", "--no-ext-diff"])?;
    let staged = shell::capture(
        root,
        "git",
        &["diff", "--cached", "--binary", "--no-ext-diff"],
    )?;
    Ok(format!("unstaged\n{unstaged}\nstaged\n{staged}"))
}

#[cfg(test)]
mod tests {
    use super::Profile;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn parses_every_explicit_profile_and_the_default() {
        assert_eq!(Profile::parse(&[]).unwrap(), Some(Profile::Default));
        assert_eq!(
            Profile::parse(&args(&["default"])).unwrap(),
            Some(Profile::Default)
        );
        assert_eq!(
            Profile::parse(&args(&["protocol"])).unwrap(),
            Some(Profile::Protocol)
        );
        assert_eq!(
            Profile::parse(&args(&["adapter-dsh"])).unwrap(),
            Some(Profile::AdapterDsh)
        );
    }

    #[test]
    fn help_is_not_a_profile_and_unknown_profiles_fail() {
        assert_eq!(Profile::parse(&args(&["--help"])).unwrap(), None);
        let error = Profile::parse(&args(&["automatic"])).unwrap_err();
        assert!(error.contains("unknown quick profile `automatic`"));
        assert!(error.contains("cargo xtask quick [profile]"));
    }

    #[test]
    fn rejects_more_than_one_profile() {
        let error = Profile::parse(&args(&["protocol", "adapter-dsh"])).unwrap_err();
        assert!(error.contains("at most one profile"));
    }

    #[test]
    fn repository_alias_starts_xtask_frozen() {
        let config = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.cargo/config.toml"),
        )
        .unwrap();
        let compact: String = config.split_whitespace().collect();
        assert!(
            compact.contains(
                "xtask=[\"run\",\"--quiet\",\"--frozen\",\"--package\",\"xtask\",\"--\",]"
            )
        );
    }
}
