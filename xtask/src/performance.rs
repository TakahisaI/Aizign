//! Manual/scheduled release-profile performance baseline orchestration.

use std::path::Path;

use crate::{cargo_build, report, shell};

pub(crate) fn run(root: &Path, args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| arg == "--binary") {
        return Err("performance-baseline builds and supplies its own release binary".to_owned());
    }

    report::stage("build TypeScript reference clients");
    shell::run(root, "npm", &["run", "build"])?;

    report::stage("build release aizign binary");
    let binary = cargo_build::aizign_release_binary(root, true)?;

    report::stage("run purpose-specific performance sweeps");
    let binary = binary
        .to_str()
        .ok_or_else(|| "release binary path is not UTF-8".to_owned())?;
    let mut runner_args = vec![
        "benchmarks/performance/run.mjs".to_owned(),
        "--binary".to_owned(),
        binary.to_owned(),
    ];
    runner_args.extend(args.iter().cloned());
    let runner_args = runner_args.iter().map(String::as_str).collect::<Vec<_>>();
    shell::run(root, "node", &runner_args)
}
