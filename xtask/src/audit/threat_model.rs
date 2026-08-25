//! The threat matrix uses a closed guarantee-level vocabulary (ADR-0015).
//! Keeping mechanism, evidence, and level in separate columns prevents CI
//! evidence from drifting into a runtime guarantee.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::audit::read_text;
use crate::report::Findings;

const THREAT_MODEL: &str = "docs/security/threat-model.md";
const HEADER: &str = "| Threat or failure | Guarantee level | Enforcement owner | Runtime response | Regression evidence | Residual limitation |";
const LEVELS: &[&str] = &[
    "Runtime enforced",
    "Detected and fail closed",
    "Trusted assumption",
    "Regression evidence",
    "Not guaranteed",
];

pub(crate) fn run(root: &Path, tracked: &[PathBuf]) -> Result<(), String> {
    let mut findings = Findings::default();
    let path = Path::new(THREAT_MODEL);
    if !tracked.iter().any(|candidate| candidate == path) {
        findings.push(format!("{THREAT_MODEL}: threat model must be tracked"));
        return findings.finish("threat-model guarantee levels");
    }
    let text = read_text(root, path)?.ok_or_else(|| format!("{THREAT_MODEL}: not UTF-8 text"))?;
    let rows = check_levels(&text, &mut findings);
    println!("{rows} threat-matrix row(s) checked");
    findings.finish("threat-model guarantee levels")
}

fn check_levels(text: &str, findings: &mut Findings) -> usize {
    let mut lines = text.lines().enumerate();
    let Some((header_line, _)) = lines.find(|(_, line)| *line == HEADER) else {
        findings.push(format!(
            "{THREAT_MODEL}: missing exact threat-matrix header"
        ));
        return 0;
    };
    let _separator = lines.next();
    let mut rows = 0;
    let mut seen = BTreeSet::new();
    for (line_number, line) in lines {
        if !line.starts_with('|') {
            break;
        }
        let columns = line
            .trim_matches('|')
            .split('|')
            .map(str::trim)
            .collect::<Vec<_>>();
        if columns.len() != 6 {
            findings.push(format!(
                "{THREAT_MODEL}:{}: expected 6 threat-matrix columns, got {}",
                line_number + 1,
                columns.len()
            ));
            continue;
        }
        rows += 1;
        let level = columns[1];
        if LEVELS.contains(&level) {
            seen.insert(level);
        } else {
            findings.push(format!(
                "{THREAT_MODEL}:{}: `{level}` is not a declared guarantee level",
                line_number + 1
            ));
        }
    }
    if rows == 0 {
        findings.push(format!(
            "{THREAT_MODEL}:{}: threat matrix has no rows",
            header_line + 1
        ));
    }
    for level in LEVELS {
        if !seen.contains(level) {
            findings.push(format!(
                "{THREAT_MODEL}: threat matrix does not exercise `{level}`"
            ));
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::{HEADER, LEVELS, check_levels};
    use crate::report::Findings;

    fn row(level: &str) -> String {
        format!("| threat | {level} | owner | response | evidence | limitation |")
    }

    #[test]
    fn accepts_only_the_declared_guarantee_levels() {
        let rows = LEVELS.iter().map(|level| row(level)).collect::<Vec<_>>();
        let document = format!("{HEADER}\n|---|---|---|---|---|---|\n{}\n", rows.join("\n"));
        let mut findings = Findings::default();
        assert_eq!(check_levels(&document, &mut findings), LEVELS.len());
        assert!(findings.is_empty());
    }

    #[test]
    fn rejects_a_compound_or_invented_level() {
        let mut rows = LEVELS.iter().map(|level| row(level)).collect::<Vec<_>>();
        rows[0] = row("Runtime enforced / fail closed");
        let document = format!("{HEADER}\n|---|---|---|---|---|---|\n{}\n", rows.join("\n"));
        let mut findings = Findings::default();
        check_levels(&document, &mut findings);
        assert_eq!(findings.len(), 2);
    }
}
