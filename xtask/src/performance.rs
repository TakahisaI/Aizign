//! Release-profile performance baseline and PR smoke orchestration.

use std::path::Path;

use crate::{cargo_build, report, shell};

pub(crate) fn run(root: &Path, args: &[String]) -> Result<(), String> {
    run_profile(root, args, &[], "run purpose-specific performance sweeps")
}

pub(crate) fn run_smoke(root: &Path, args: &[String]) -> Result<(), String> {
    if args
        .iter()
        .any(|arg| arg == "--profile" || arg == "--sweeps")
    {
        return Err("performance-smoke fixes its profile and sweep selection".to_owned());
    }
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

fn run_profile(root: &Path, args: &[String], defaults: &[&str], stage: &str) -> Result<(), String> {
    if args.iter().any(|arg| arg == "--binary") {
        return Err("performance runner builds and supplies its own release binary".to_owned());
    }

    report::stage("build TypeScript reference clients");
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
