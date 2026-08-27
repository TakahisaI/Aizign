//! Structural validation of the language-neutral fixtures under
//! `spec/conformance`.
//!
//! Fixtures are shared by the Rust and TypeScript implementations of the
//! protocol and by the journal / commit-metadata store, so this command only
//! checks what is true regardless of language: the directory layout, that every invalid
//! frame has an expectation file with a well-formed code and a schema
//! classification, and that valid frames are JSON. Running the frames
//! through the actual decoders is the job of the protocol crates and
//! packages and of `aizign-store-jsonl`; validating them against the JSON
//! Schemas is the job of the spec schema gate. They all read these files.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::report::{self, Findings};

const FIXTURE_ROOT: &str = "spec/conformance";
const PROCESS_FIXTURE: &str = "spec/process/v1/fixtures/cases.json";
/// The wire directions plus both durable-format documents; each has its own
/// decoder and JSON Schema, and the fixtures keep them aligned.
const DIRECTIONS: [&str; 4] = ["request", "response", "journal", "store"];

pub(crate) fn run(root: &Path) -> Result<(), String> {
    report::stage("conformance fixtures");
    let fixture_root = root.join(FIXTURE_ROOT);
    if !fixture_root.is_dir() {
        return Err(format!("{FIXTURE_ROOT}/ is missing"));
    }

    let mut findings = Findings::default();
    let mut valid_count = 0;
    let mut invalid_count = 0;

    for direction in DIRECTIONS {
        valid_count += check_valid(&fixture_root.join("valid").join(direction), &mut findings)?;
        invalid_count += check_invalid(
            &fixture_root.join("invalid").join(direction),
            direction == "request",
            &mut findings,
        )?;
    }
    check_process_fixture(root, &mut findings)?;

    println!("{valid_count} valid, {invalid_count} invalid fixture(s)");
    findings.finish("conformance")
}

fn check_process_fixture(root: &Path, findings: &mut Findings) -> Result<(), String> {
    let path = root.join(PROCESS_FIXTURE);
    let bytes = fs::read(&path).map_err(|error| format!("{PROCESS_FIXTURE}: {error}"))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{PROCESS_FIXTURE}: not JSON: {error}"))?;
    let Some(object) = value.as_object() else {
        findings.push(format!("{PROCESS_FIXTURE}: root must be an object"));
        return Ok(());
    };
    let expected_root: BTreeSet<&str> =
        ["fixtureVersion", "authority", "normative", "cases"].into();
    let actual_root: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    if actual_root != expected_root {
        findings.push(format!(
            "{PROCESS_FIXTURE}: root keys must be exactly {expected_root:?}"
        ));
    }
    if object
        .get("fixtureVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        findings.push(format!("{PROCESS_FIXTURE}: fixtureVersion must be 1"));
    }
    if object.get("authority").and_then(serde_json::Value::as_str)
        != Some("spec/process/v1/README.md")
    {
        findings.push(format!(
            "{PROCESS_FIXTURE}: authority must name spec/process/v1/README.md"
        ));
    }
    if object.get("normative").and_then(serde_json::Value::as_bool) != Some(false) {
        findings.push(format!("{PROCESS_FIXTURE}: normative must be false"));
    }

    let Some(cases) = object.get("cases").and_then(serde_json::Value::as_array) else {
        findings.push(format!("{PROCESS_FIXTURE}: cases must be an array"));
        return Ok(());
    };
    if cases.len() != 55 {
        findings.push(format!(
            "{PROCESS_FIXTURE}: expected 55 projected cases, found {}",
            cases.len()
        ));
    }
    let expected_case: BTreeSet<&str> = [
        "id",
        "group",
        "stage",
        "stimulus",
        "responseVersion",
        "responseCode",
        "correlation",
        "effect",
        "parent",
        "evidence",
    ]
    .into();
    let mut ids = BTreeSet::new();
    for (index, case) in cases.iter().enumerate() {
        let Some(case) = case.as_object() else {
            findings.push(format!(
                "{PROCESS_FIXTURE}: cases[{index}] must be an object"
            ));
            continue;
        };
        let actual_case: BTreeSet<&str> = case.keys().map(String::as_str).collect();
        if actual_case != expected_case {
            findings.push(format!(
                "{PROCESS_FIXTURE}: cases[{index}] keys must be exactly {expected_case:?}"
            ));
        }
        match case.get("id").and_then(serde_json::Value::as_str) {
            Some(id) if ids.insert(id) => {}
            Some(id) => findings.push(format!("{PROCESS_FIXTURE}: duplicate case id `{id}`")),
            None => findings.push(format!(
                "{PROCESS_FIXTURE}: cases[{index}] has no string id"
            )),
        }
        if case
            .get("evidence")
            .and_then(serde_json::Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            findings.push(format!(
                "{PROCESS_FIXTURE}: cases[{index}].evidence must be non-empty"
            ));
        }
    }
    Ok(())
}

fn check_valid(dir: &Path, findings: &mut Findings) -> Result<usize, String> {
    let files = list(dir, findings)?;
    for path in &files {
        let name = display(path);
        if path
            .extension()
            .is_none_or(|extension| extension != "frame")
        {
            findings.push(format!("{name}: valid fixtures are `.frame` files"));
            continue;
        }
        let bytes = fs::read(path).map_err(|error| format!("{name}: {error}"))?;
        if serde_json::from_slice::<serde_json::Value>(&bytes).is_err() {
            findings.push(format!("{name}: valid frames must be JSON"));
        }
        if bytes.ends_with(b"\n") {
            findings.push(format!(
                "{name}: frames are stored without a trailing newline"
            ));
        }
    }
    Ok(files.len())
}

fn check_invalid(dir: &Path, is_request: bool, findings: &mut Findings) -> Result<usize, String> {
    let files = list(dir, findings)?;
    let mut frames: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut expects: BTreeMap<String, PathBuf> = BTreeMap::new();
    for path in files {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if let Some(stem) = file_name.strip_suffix(".expect.json") {
            expects.insert(stem.to_owned(), path);
        } else if let Some(stem) = file_name.strip_suffix(".frame") {
            frames.insert(stem.to_owned(), path);
        } else {
            findings.push(format!(
                "{}: invalid fixtures are `.frame` + `.expect.json` pairs",
                display(&path)
            ));
        }
    }

    for stem in frames.keys() {
        if !expects.contains_key(stem) {
            findings.push(format!(
                "{}/{stem}.frame: missing {stem}.expect.json",
                display(dir)
            ));
        }
    }
    for (stem, path) in &expects {
        if !frames.contains_key(stem) {
            findings.push(format!("{}: missing {stem}.frame", display(path)));
        }
        check_expectation(path, is_request, findings)?;
    }
    Ok(frames.len())
}

fn check_expectation(path: &Path, is_request: bool, findings: &mut Findings) -> Result<(), String> {
    let name = display(path);
    let bytes = fs::read(path).map_err(|error| format!("{name}: {error}"))?;
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            findings.push(format!("{name}: not JSON: {error}"));
            return Ok(());
        }
    };
    let Some(object) = value.as_object() else {
        findings.push(format!("{name}: expectation must be an object"));
        return Ok(());
    };

    let allowed: &[&str] = if is_request {
        &["code", "requestId", "kind", "schema"]
    } else {
        &["code", "schema"]
    };
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            findings.push(format!("{name}: unexpected key `{key}`"));
        }
    }
    match object.get("code").and_then(serde_json::Value::as_str) {
        Some(code) if is_short_code(code) => {}
        _ => findings.push(format!(
            "{name}: `code` must match ^[A-Z][A-Z0-9_]{{0,63}}$"
        )),
    }
    if !object
        .get("schema")
        .is_some_and(serde_json::Value::is_boolean)
    {
        findings.push(format!(
            "{name}: `schema` must state whether the frame validates against the JSON Schema \
             (true only where the schema cannot express the rule, e.g. the size bound)"
        ));
    }
    if is_request {
        for key in ["requestId", "kind"] {
            match object.get(key) {
                Some(serde_json::Value::String(_) | serde_json::Value::Null) => {}
                _ => findings.push(format!("{name}: `{key}` must be a string or null")),
            }
        }
    }
    Ok(())
}

fn is_short_code(code: &str) -> bool {
    let mut bytes = code.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_uppercase())
        && code.len() <= 64
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn list(dir: &Path, findings: &mut Findings) -> Result<Vec<PathBuf>, String> {
    if !dir.is_dir() {
        findings.push(format!("missing fixture directory {}", display(dir)));
        return Ok(Vec::new());
    }
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|error| format!("{}: {error}", display(dir)))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<_, _>>()
        .map_err(|error| format!("{}: {error}", display(dir)))?;
    files.retain(|path| path.is_file());
    files.sort();
    if files.is_empty() {
        findings.push(format!("{}: no fixtures", display(dir)));
    }
    Ok(files)
}

fn display(path: &Path) -> String {
    let rendered = path.display().to_string();
    rendered
        .find(FIXTURE_ROOT)
        .map_or(rendered.clone(), |index| rendered[index..].to_owned())
}
