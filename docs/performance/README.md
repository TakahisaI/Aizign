# Performance reports

This directory stores reviewed interpretations of runtime performance observations. Machine-readable raw samples remain in scheduled or manual workflow artifacts; reports here record the environment, configuration, representative values, and interpretation.

The [initial development observation](2026-08-24-initial-baseline.md) is runner v2 history. Its parent timing, concurrency, DSH, and lost-ACK values are not compatible with the corrected runner v3 baseline.

The [initial performance budgets and PR smoke policy](2026-08-25-performance-budgets.md) reference three fixed `ubuntu-24.04` runner v3 artifacts. That report records the provisional gross-regression ceilings, canonical scenario operation counts, informational period, required-gate promotion criteria, and optimization triggers introduced by Issue #58.

See the [performance runner documentation](../../benchmarks/performance/README.md) for measurement contracts and reproduction commands.

Every new report must record:

- commit and dirty-tree status;
- OS, architecture, CPU, filesystem, Rust, Node, and build profile;
- warmup count, sample count, and percentile method;
- core watchdog comparison and headroom;
- workflow runs containing `result.json` and `summary.md`;
- observed trends and interpretation limits caused by environment or sample count;
- multiple comparable runs when proposing a budget change.

Do not turn one run into a fine-grained CI threshold. Budget changes require comparable observations, explicit noise allowance, and documented regression triage. GitHub-hosted runs may support generous gross-regression ceilings but are not a stable microbenchmark environment.
