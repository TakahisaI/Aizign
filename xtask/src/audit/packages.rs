//! npm workspace manifests: the root stays private and every workspace
//! package keeps a closed `exports` map (ADR-0005, ADR-0008).

use std::path::{Path, PathBuf};

use crate::audit::{display, read_text};
use crate::report::Findings;

pub(crate) fn run(root: &Path, tracked: &[PathBuf]) -> Result<(), String> {
    let mut findings = Findings::default();
    let mut checked = 0;

    for path in tracked {
        if path.file_name().is_none_or(|name| name != "package.json") {
            continue;
        }
        let Some(text) = read_text(root, path)? else {
            continue;
        };
        let rendered = display(path);
        let manifest: serde_json::Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(error) => {
                findings.push(format!("{rendered}: not valid JSON: {error}"));
                continue;
            }
        };
        checked += 1;

        if manifest["private"] != serde_json::Value::Bool(true) {
            findings.push(format!(
                "{rendered}: `private` must be true until registry publication is enabled by ADR"
            ));
        }

        if is_workspace_package(path) {
            check_workspace_package(&rendered, &manifest, &mut findings);
        } else if path.components().count() == 1 {
            check_root(&rendered, &manifest, &mut findings);
        } else {
            findings.push(format!(
                "{rendered}: package.json outside the root, packages/*, or adapters/*"
            ));
        }
    }

    println!("{checked} package manifest(s) checked");
    findings.finish("package manifests")
}

fn is_workspace_package(path: &Path) -> bool {
    let components: Vec<String> = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    components.len() == 3 && matches!(components[0].as_str(), "packages" | "adapters")
}

fn check_root(rendered: &str, manifest: &serde_json::Value, findings: &mut Findings) {
    let workspaces = manifest["workspaces"].as_array();
    let declared: Vec<&str> = workspaces
        .map(|entries| {
            entries
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect()
        })
        .unwrap_or_default();
    for required in ["packages/*", "adapters/*"] {
        if !declared.contains(&required) {
            findings.push(format!(
                "{rendered}: `workspaces` must include `{required}`"
            ));
        }
    }
}

fn check_workspace_package(rendered: &str, manifest: &serde_json::Value, findings: &mut Findings) {
    let name = manifest["name"].as_str().unwrap_or_default();
    if !name.starts_with("@aizu/") {
        findings.push(format!(
            "{rendered}: workspace packages are named `@aizu/<name>`"
        ));
    }

    match manifest["exports"].as_object() {
        None => findings.push(format!(
            "{rendered}: `exports` must be an object (closed map)"
        )),
        Some(exports) => {
            if !exports.contains_key(".") {
                findings.push(format!("{rendered}: `exports` must define the `.` entry"));
            }
            for key in exports.keys() {
                if !key.starts_with('.') || key.contains('*') {
                    findings.push(format!(
                        "{rendered}: `exports` key `{key}` is not a closed subpath (no wildcards)"
                    ));
                }
            }
        }
    }

    if manifest["files"].as_array().is_none() {
        findings.push(format!(
            "{rendered}: `files` must list the published contents"
        ));
    }
}
