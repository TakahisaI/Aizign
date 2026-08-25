//! The threat matrix uses a closed guarantee-level vocabulary (ADR-0015).
//! Keeping mechanism, evidence, and level in separate columns prevents CI
//! evidence from drifting into a runtime guarantee.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::audit::read_text;
use crate::report::Findings;

const THREAT_MODEL: &str = "docs/security/threat-model.md";
const SECTION: &str = "## Threat and failure matrix";
const HEADER: &str = "| Threat or failure | Guarantee level | Enforcement owner | Runtime response | Regression evidence | Residual limitation |";
const SEPARATOR: &str = "|---|---|---|---|---|---|";
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
    let lines = text.lines().collect::<Vec<_>>();
    let Some((header_line, section_end)) = table_bounds(&lines, findings) else {
        return 0;
    };
    let row_start = first_row(&lines, header_line, findings);

    let mut rows = 0;
    let mut seen = BTreeSet::new();
    for (line_number, line) in lines.iter().enumerate().take(section_end).skip(row_start) {
        if *line == HEADER {
            break;
        }
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

fn table_bounds(lines: &[&str], findings: &mut Findings) -> Option<(usize, usize)> {
    let sections = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| (*line == SECTION).then_some(index))
        .collect::<Vec<_>>();
    if sections.len() != 1 {
        findings.push(format!(
            "{THREAT_MODEL}: expected exactly one `{SECTION}` section, got {}",
            sections.len()
        ));
    }
    let &section_line = sections.first()?;
    let section_end = lines
        .iter()
        .enumerate()
        .skip(section_line + 1)
        .find_map(|(index, line)| line.starts_with("## ").then_some(index))
        .unwrap_or(lines.len());

    let headers = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| (*line == HEADER).then_some(index))
        .collect::<Vec<_>>();
    if headers.len() != 1 {
        findings.push(format!(
            "{THREAT_MODEL}: expected exactly one exact threat-matrix header, got {}",
            headers.len()
        ));
    }
    let Some(header_line) = headers
        .iter()
        .copied()
        .find(|index| *index > section_line && *index < section_end)
    else {
        findings.push(format!(
            "{THREAT_MODEL}: missing exact threat-matrix header inside `{SECTION}`"
        ));
        return None;
    };

    Some((header_line, section_end))
}

fn first_row(lines: &[&str], header_line: usize, findings: &mut Findings) -> usize {
    let separator_line = header_line + 1;
    let mut row_start = separator_line;
    match lines.get(separator_line) {
        Some(line) if *line == SEPARATOR => row_start += 1,
        Some(line) => {
            findings.push(format!(
                "{THREAT_MODEL}:{}: expected exact threat-matrix separator `{SEPARATOR}`",
                separator_line + 1
            ));
            if is_separator_like(line) {
                row_start += 1;
            }
        }
        None => findings.push(format!(
            "{THREAT_MODEL}:{}: missing threat-matrix separator",
            separator_line + 1
        )),
    }
    row_start
}

fn is_separator_like(line: &str) -> bool {
    let columns = line.trim_matches('|').split('|').map(str::trim);
    let mut count = 0;
    for column in columns {
        count += 1;
        let trimmed = column.trim_matches(':');
        if trimmed.len() < 2 || !trimmed.chars().all(|character| character == '-') {
            return false;
        }
    }
    count == 6
}

#[cfg(test)]
mod tests {
    use super::{HEADER, LEVELS, SECTION, SEPARATOR, check_levels};
    use crate::report::Findings;

    fn row(level: &str) -> String {
        format!("| threat | {level} | owner | response | evidence | limitation |")
    }

    #[test]
    fn accepts_only_the_declared_guarantee_levels() {
        let rows = LEVELS.iter().map(|level| row(level)).collect::<Vec<_>>();
        let document = format!(
            "{SECTION}\n\nintro\n\n{HEADER}\n{SEPARATOR}\n{}\n",
            rows.join("\n")
        );
        let mut findings = Findings::default();
        assert_eq!(check_levels(&document, &mut findings), LEVELS.len());
        assert!(findings.is_empty());
    }

    #[test]
    fn rejects_a_compound_or_invented_level() {
        let mut rows = LEVELS.iter().map(|level| row(level)).collect::<Vec<_>>();
        rows[0] = row("Runtime enforced / fail closed");
        let document = format!("{SECTION}\n{HEADER}\n{SEPARATOR}\n{}\n", rows.join("\n"));
        let mut findings = Findings::default();
        check_levels(&document, &mut findings);
        assert_eq!(findings.len(), 2);
    }

    #[test]
    fn missing_separator_does_not_skip_the_first_invalid_row() {
        let mut rows = LEVELS.iter().map(|level| row(level)).collect::<Vec<_>>();
        rows[0] = row("invented");
        let document = format!("{SECTION}\n{HEADER}\n{}\n", rows.join("\n"));
        let mut findings = Findings::default();
        assert_eq!(check_levels(&document, &mut findings), LEVELS.len());
        assert_eq!(findings.len(), 3);
    }

    #[test]
    fn rejects_a_malformed_separator_without_treating_it_as_data() {
        let rows = LEVELS.iter().map(|level| row(level)).collect::<Vec<_>>();
        let document = format!(
            "{SECTION}\n{HEADER}\n|--|---|---|---|---|---|\n{}\n",
            rows.join("\n")
        );
        let mut findings = Findings::default();
        assert_eq!(check_levels(&document, &mut findings), LEVELS.len());
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn rejects_duplicate_section_or_header_markers() {
        let rows = LEVELS.iter().map(|level| row(level)).collect::<Vec<_>>();
        let duplicate_section = format!(
            "{SECTION}\n{HEADER}\n{SEPARATOR}\n{}\n\n{SECTION}\n",
            rows.join("\n")
        );
        let mut findings = Findings::default();
        check_levels(&duplicate_section, &mut findings);
        assert_eq!(findings.len(), 1);

        let duplicate_header = format!(
            "{SECTION}\n{HEADER}\n{SEPARATOR}\n{}\n{HEADER}\n",
            rows.join("\n")
        );
        let mut findings = Findings::default();
        check_levels(&duplicate_header, &mut findings);
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn rejects_missing_section_or_header_markers() {
        let rows = LEVELS.iter().map(|level| row(level)).collect::<Vec<_>>();
        let missing_section = format!("{HEADER}\n{SEPARATOR}\n{}\n", rows.join("\n"));
        let mut findings = Findings::default();
        assert_eq!(check_levels(&missing_section, &mut findings), 0);
        assert_eq!(findings.len(), 1);

        let missing_header = format!("{SECTION}\n{SEPARATOR}\n{}\n", rows.join("\n"));
        let mut findings = Findings::default();
        assert_eq!(check_levels(&missing_header, &mut findings), 0);
        assert_eq!(findings.len(), 2);
    }
}
