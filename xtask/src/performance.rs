//! Release-profile performance baseline and PR smoke orchestration.

use std::path::Path;

use crate::{cargo_build, report, shell};

pub(crate) fn run(root: &Path, args: &[String]) -> Result<(), String> {
    run_profile(root, args, &[], "run purpose-specific performance sweeps")
}

pub(crate) fn run_smoke(root: &Path, args: &[String]) -> Result<(), String> {
    validate_smoke_args(args)?;
    run_profile(
        root,
        args,
        &[
            "--profile",
            "pr-smoke",
            "--output-dir",
            "target/performance-smoke",
            "--warmup",
            "1",
            "--samples",
            "3",
            "--sweeps",
            "transport,concurrency,scenarios",
        ],
        "run informational PR performance smoke",
    )
}

fn validate_smoke_args(args: &[String]) -> Result<(), String> {
    if args.is_empty() {
        Ok(())
    } else {
        Err("performance-smoke has no configurable runner options".to_owned())
    }
}

fn run_profile(root: &Path, args: &[String], defaults: &[&str], stage: &str) -> Result<(), String> {
    if args.iter().any(|arg| arg == "--binary") {
        return Err("performance runner builds and supplies its own release binary".to_owned());
    }

    report::stage("build TypeScript packages and DSH client");
    shell::run(root, "npm", &["run", "build"])?;

    report::stage("build release aizign binary");
    let binary = cargo_build::aizign_release_binary(root, true)?;

    report::stage(stage);
    let binary = binary
        .to_str()
        .ok_or_else(|| "release binary path is not UTF-8".to_owned())?;
    let mut runner_args = vec![
        "benchmarks/performance/run.mjs".to_owned(),
        "--binary".to_owned(),
        binary.to_owned(),
    ];
    runner_args.extend(defaults.iter().map(|arg| (*arg).to_owned()));
    runner_args.extend(args.iter().cloned());
    let runner_args = runner_args.iter().map(String::as_str).collect::<Vec<_>>();
    shell::run(root, "node", &runner_args)
}

#[cfg(test)]
mod tests {
    use super::validate_smoke_args;

    #[test]
    fn smoke_configuration_cannot_be_overridden() {
        assert!(validate_smoke_args(&[]).is_ok());
        for args in [
            vec!["--samples".to_owned(), "1".to_owned()],
            vec!["--warmup".to_owned(), "0".to_owned()],
            vec!["--output-dir".to_owned(), "elsewhere".to_owned()],
            vec!["--sweeps".to_owned(), "transport".to_owned()],
        ] {
            assert!(validate_smoke_args(&args).is_err());
        }
    }
}
