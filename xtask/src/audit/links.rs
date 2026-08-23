//! Relative links in tracked Markdown files must resolve to tracked paths.

use std::path::{Path, PathBuf};

use crate::audit::{display, read_text};
use crate::report::Findings;

pub(crate) fn run(root: &Path, tracked: &[PathBuf]) -> Result<(), String> {
    let mut findings = Findings::default();
    let mut documents = 0;
    let mut links = 0;

    for path in tracked {
        if path.extension().is_none_or(|extension| extension != "md") {
            continue;
        }
        let Some(text) = read_text(root, path)? else {
            continue;
        };
        documents += 1;
        let base = path.parent().unwrap_or(Path::new(""));
        for (line_number, line) in text.lines().enumerate() {
            for target in targets(line) {
                links += 1;
                if is_external(target) {
                    continue;
                }
                let target_path = target.split('#').next().unwrap_or_default();
                if target_path.is_empty() {
                    continue;
                }
                let resolved = if let Some(absolute) = target_path.strip_prefix('/') {
                    root.join(absolute)
                } else {
                    root.join(base).join(target_path)
                };
                if !resolved.exists() {
                    findings.push(format!(
                        "{}:{}: link target `{target}` does not exist",
                        display(path),
                        line_number + 1
                    ));
                }
            }
        }
    }

    println!("{documents} document(s), {links} link(s) checked");
    findings.finish("documentation links")
}

fn is_external(target: &str) -> bool {
    target.starts_with("http://")
        || target.starts_with("https://")
        || target.starts_with("mailto:")
        || target.starts_with('#')
        || target.starts_with('<')
}

/// Extracts `](target)` link targets from one line, ignoring inline code.
fn targets(line: &str) -> Vec<&str> {
    let mut targets = Vec::new();
    let mut in_code = false;
    let bytes = line.as_bytes();
    let mut offset = 0;

    while offset < bytes.len() {
        match bytes[offset] {
            b'`' => {
                in_code = !in_code;
                offset += 1;
            }
            b']' if !in_code && bytes.get(offset + 1) == Some(&b'(') => {
                let rest = &line[offset + 2..];
                let Some(end) = rest.find(')') else { break };
                let target = rest[..end].split_whitespace().next().unwrap_or_default();
                targets.push(target);
                offset += 2 + end + 1;
            }
            _ => offset += 1,
        }
    }
    targets
}

#[cfg(test)]
mod tests {
    use super::targets;

    #[test]
    fn extracts_targets_and_ignores_inline_code() {
        assert_eq!(
            targets("see [a](docs/a.md) and [b](../b.md#x) but not `[c](d)`"),
            ["docs/a.md", "../b.md#x"]
        );
        assert_eq!(targets("[t](path 'title')"), ["path"]);
    }
}
