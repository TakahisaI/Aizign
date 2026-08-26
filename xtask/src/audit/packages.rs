//! npm workspace manifests: the root stays private and every workspace
//! package keeps a closed `exports` map (ADR-0005, ADR-0008).

use std::collections::BTreeSet;
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

    check_typescript_sources(root, tracked, &mut findings)?;

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
    if !name.starts_with("@aizign/") {
        findings.push(format!(
            "{rendered}: workspace packages are named `@aizign/<name>`"
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
            if let Some(expected) = expected_subpaths(name) {
                let actual: BTreeSet<&str> = exports.keys().map(String::as_str).collect();
                let expected: BTreeSet<&str> = expected.iter().copied().collect();
                if actual != expected {
                    findings.push(format!(
                        "{rendered}: exact export subpaths are {actual:?}; expected {expected:?}"
                    ));
                }
            }
        }
    }

    check_workspace_dependencies(rendered, name, manifest, findings);

    if manifest["files"].as_array().is_none() {
        findings.push(format!(
            "{rendered}: `files` must list the published contents"
        ));
    }
}

fn expected_subpaths(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "@aizign/protocol" | "@aizign/adapter-testkit" => Some(&[".", "./package.json"]),
        "@aizign/adapter-dsh" => Some(&[
            ".",
            "./experimental/evidence",
            "./experimental/transport",
            "./package.json",
        ]),
        _ => None,
    }
}

fn check_workspace_dependencies(
    rendered: &str,
    name: &str,
    manifest: &serde_json::Value,
    findings: &mut Findings,
) {
    if !matches!(
        name,
        "@aizign/protocol" | "@aizign/adapter-testkit" | "@aizign/adapter-dsh"
    ) {
        return;
    }

    for kind in [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
        "bundleDependencies",
        "bundledDependencies",
    ] {
        let actual = declared_workspace_dependencies(rendered, kind, manifest, findings);
        let expected: BTreeSet<&str> = expected_workspace_dependencies(name, kind)
            .iter()
            .copied()
            .collect();
        if actual != expected {
            findings.push(format!(
                "{rendered}: exact {kind} workspace packages are {actual:?}; expected {expected:?}"
            ));
        }
    }
}

fn expected_workspace_dependencies(name: &str, kind: &str) -> &'static [&'static str] {
    match (name, kind) {
        ("@aizign/adapter-testkit" | "@aizign/adapter-dsh", "dependencies") => {
            &["@aizign/protocol"]
        }
        ("@aizign/adapter-dsh", "devDependencies") => &["@aizign/adapter-testkit"],
        _ => &[],
    }
}

fn declared_workspace_dependencies<'a>(
    rendered: &str,
    kind: &str,
    manifest: &'a serde_json::Value,
    findings: &mut Findings,
) -> BTreeSet<&'a str> {
    let value = &manifest[kind];
    if matches!(kind, "bundleDependencies" | "bundledDependencies") {
        return match value {
            serde_json::Value::Null | serde_json::Value::Bool(false) => BTreeSet::new(),
            serde_json::Value::Array(entries) => {
                if entries.iter().any(|entry| !entry.is_string()) {
                    findings.push(format!(
                        "{rendered}: `{kind}` entries must all be package-name strings"
                    ));
                }
                entries
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .filter(|dependency| dependency.starts_with("@aizign/"))
                    .collect()
            }
            serde_json::Value::Bool(true) => {
                findings.push(format!(
                    "{rendered}: `{kind}: true` can implicitly bundle workspace dependencies; use an explicit array"
                ));
                manifest["dependencies"]
                    .as_object()
                    .into_iter()
                    .flat_map(|entries| entries.keys())
                    .map(String::as_str)
                    .filter(|dependency| dependency.starts_with("@aizign/"))
                    .collect()
            }
            _ => {
                findings.push(format!(
                    "{rendered}: `{kind}` must be absent, false, or an array of package names"
                ));
                BTreeSet::new()
            }
        };
    }

    match value {
        serde_json::Value::Null => BTreeSet::new(),
        serde_json::Value::Object(entries) => entries
            .keys()
            .map(String::as_str)
            .filter(|dependency| dependency.starts_with("@aizign/"))
            .collect(),
        _ => {
            findings.push(format!(
                "{rendered}: `{kind}` must be an object when present"
            ));
            BTreeSet::new()
        }
    }
}

fn check_typescript_sources(
    root: &Path,
    tracked: &[PathBuf],
    findings: &mut Findings,
) -> Result<(), String> {
    const PACKAGE_BYPASSES: &[&str] = &[
        "@aizign/protocol/src/",
        "@aizign/protocol/lib/",
        "@aizign/adapter-testkit/src/",
        "@aizign/adapter-testkit/lib/",
        "@aizign/adapter-dsh/src/",
        "@aizign/adapter-dsh/lib/",
        "packages/protocol/src/",
        "packages/protocol/lib/",
        "packages/adapter-testkit/src/",
        "packages/adapter-testkit/lib/",
        "adapters/dsh/src/",
        "adapters/dsh/lib/",
        "../protocol/src/",
        "../protocol/lib/",
        "../adapter-testkit/src/",
        "../adapter-testkit/lib/",
        "../dsh/src/",
        "../dsh/lib/",
    ];
    const PROTOCOL_FORBIDDEN: &[&str] = &[
        "node:",
        "child_process",
        "process.",
        "stateDir",
        "timeoutMs",
        "timingSink",
        "ParentTiming",
        "preflight",
    ];

    for path in tracked {
        let extension = path.extension().and_then(|value| value.to_str());
        if !matches!(extension, Some("ts" | "mjs" | "js")) {
            continue;
        }
        let Some(text) = read_text(root, path)? else {
            continue;
        };

        for (index, line) in text.lines().enumerate() {
            let location = format!("{}:{}", display(path), index + 1);
            let trimmed = line.trim_start();
            let is_comment =
                trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*');
            if !is_comment && path != Path::new("spec/test/package-exports.test.mjs") {
                for bypass in PACKAGE_BYPASSES {
                    if line.contains(bypass) {
                        findings.push(format!(
                            "{location}: package source/build bypass `{bypass}`; use a declared package subpath"
                        ));
                    }
                }
            }

            let protocol_source = path.starts_with("packages/protocol/src")
                && !path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".test.ts"));
            if protocol_source {
                for token in PROTOCOL_FORBIDDEN {
                    if line.contains(token) {
                        findings.push(format!(
                            "{location}: Protocol production source contains DSH/process token `{token}`"
                        ));
                    }
                }
            }

            if path != Path::new("spec/test/package-exports.test.mjs")
                && line.contains("ReferenceOneShotClient")
            {
                findings.push(format!(
                    "{location}: duplicate reference transport must not return"
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn dependency_findings(name: &str, manifest: &serde_json::Value) -> Findings {
        let mut findings = Findings::default();
        check_workspace_dependencies("package.json", name, manifest, &mut findings);
        findings
    }

    #[test]
    fn accepted_dependency_sections_are_exact() {
        let manifest = json!({
            "dependencies": { "@aizign/protocol": "0.1.0" },
            "devDependencies": { "@aizign/adapter-testkit": "0.1.0" },
            "peerDependencies": { "external-package": "1.0.0" }
        });
        assert!(dependency_findings("@aizign/adapter-dsh", &manifest).is_empty());
    }

    #[test]
    fn peer_and_optional_sections_cannot_bypass_direction() {
        let peer = json!({ "peerDependencies": { "@aizign/adapter-dsh": "0.1.0" } });
        let optional = json!({ "optionalDependencies": { "@aizign/adapter-dsh": "0.1.0" } });
        assert_eq!(dependency_findings("@aizign/protocol", &peer).len(), 1);
        assert_eq!(dependency_findings("@aizign/protocol", &optional).len(), 1);
    }

    #[test]
    fn bundled_dependency_aliases_cannot_bypass_direction() {
        let bundle = json!({ "bundleDependencies": ["@aizign/adapter-dsh"] });
        let bundled = json!({ "bundledDependencies": ["@aizign/adapter-dsh"] });
        assert_eq!(dependency_findings("@aizign/protocol", &bundle).len(), 1);
        assert_eq!(dependency_findings("@aizign/protocol", &bundled).len(), 1);
    }

    #[test]
    fn implicit_bundle_all_is_rejected() {
        let manifest = json!({
            "dependencies": { "@aizign/protocol": "0.1.0" },
            "bundleDependencies": true
        });
        assert_eq!(
            dependency_findings("@aizign/adapter-testkit", &manifest).len(),
            2
        );
    }
}
