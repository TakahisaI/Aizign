//! The Rust gates: format, lint, test, documentation, and dependency policy.

use std::{fs, path::Path, str};

use crate::{report, shell};

const DENY_VERSION_FILE: &str = ".cargo-deny-version";

pub(crate) fn run(root: &Path) -> Result<(), String> {
    report::stage("cargo fmt");
    shell::run(root, "cargo", &["fmt", "--all", "--check"])?;

    report::stage("cargo clippy");
    shell::run(
        root,
        "cargo",
        &[
            "clippy",
            "--workspace",
            "--all-targets",
            "--all-features",
            "--",
            "-D",
            "warnings",
        ],
    )?;

    report::stage("cargo test");
    shell::run(root, "cargo", &["test", "--workspace"])?;

    report::stage("cargo doc");
    shell::run_with_env(
        root,
        "cargo",
        &["doc", "--workspace", "--no-deps"],
        &[("RUSTDOCFLAGS", "-D warnings")],
    )?;

    report::stage("cargo deny");
    run_deny_check(root, &[])?;

    // Package contents inspection: every crate must package cleanly even
    // though registry publication stays disabled (release gate, ADR-0008).
    report::stage("cargo package --list");
    shell::run(
        root,
        "cargo",
        &[
            "package",
            "--list",
            "--workspace",
            "--allow-dirty",
            "--quiet",
        ],
    )?;

    Ok(())
}

fn run_deny_check(root: &Path, env: &[(&str, &str)]) -> Result<(), String> {
    verify_deny_version(root, env)?;
    shell::run_with_env(root, "cargo", &["deny", "check"], env)
}

fn verify_deny_version(root: &Path, env: &[(&str, &str)]) -> Result<(), String> {
    let expected =
        read_deny_version(root).map_err(|error| format!("{error}\n{}", deny_install_hint(None)))?;
    let output =
        shell::capture_with_env(root, "cargo", &["deny", "--version"], env).map_err(|error| {
            format!(
                "cargo-deny version check failed: {error}\n{}",
                deny_install_hint(Some(&expected))
            )
        })?;
    validate_deny_version_output(&output, &expected)
        .map_err(|error| format!("{error}\n{}", deny_install_hint(Some(&expected))))
}

fn read_deny_version(root: &Path) -> Result<String, String> {
    let path = root.join(DENY_VERSION_FILE);
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "cargo-deny version authority `{}` could not be read: {error}",
            path.display()
        )
    })?;
    parse_deny_version_file(&bytes).map_err(|error| {
        format!(
            "cargo-deny version authority `{}` is invalid: {error}",
            path.display()
        )
    })
}

fn parse_deny_version_file(bytes: &[u8]) -> Result<String, String> {
    if bytes.last() != Some(&b'\n') {
        return Err("expected exactly one terminal LF byte (0x0A)".to_owned());
    }
    let value_bytes = &bytes[..bytes.len() - 1];
    if value_bytes.contains(&b'\n') {
        return Err("expected exactly one line".to_owned());
    }
    let value = str::from_utf8(value_bytes).map_err(|_| "expected UTF-8 bytes".to_owned())?;
    let mut parts = value.split('.');
    let valid = parts.clone().count() == 3
        && parts.all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
        });
    if !valid {
        return Err(
            "expected MAJOR.MINOR.PATCH digits with no whitespace or extra tokens".to_owned(),
        );
    }
    Ok(value.to_owned())
}

fn validate_deny_version_output(output: &str, expected: &str) -> Result<(), String> {
    let line = output
        .strip_suffix('\n')
        .ok_or_else(|| "cargo deny --version must end with exactly one LF byte".to_owned())?;
    let expected_line = format!("cargo-deny {expected}");
    if line != expected_line {
        return Err(format!(
            "cargo deny --version output `{line}` does not exactly match `{expected_line}`"
        ));
    }
    Ok(())
}

fn deny_install_hint(expected: Option<&str>) -> String {
    match expected {
        Some(expected) => format!(
            "cargo-deny {expected} is required for `cargo xtask rust-check`.\n\
             install it with `cargo install cargo-deny --version {expected} --locked`;\n\
             version authority: `{DENY_VERSION_FILE}`"
        ),
        None => format!(
            "restore the exact value in `{DENY_VERSION_FILE}`, then install it with \
             `cargo install cargo-deny --version \"$(bash .github/scripts/read-cargo-deny-version.sh)\" --locked`;\n\
             version authority: `{DENY_VERSION_FILE}`"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_deny_version_file, validate_deny_version_output};

    #[test]
    fn authority_requires_one_lf_terminated_semver_line() {
        assert_eq!(parse_deny_version_file(b"0.20.2\n").unwrap(), "0.20.2");
        for invalid in [
            b"0.20.2".as_slice(),
            b"0.20.2\n\n".as_slice(),
            b"0.20.2 \\n".as_slice(),
            b"0.20.2\\n\n".as_slice(),
            b"0.20\n".as_slice(),
        ] {
            assert!(parse_deny_version_file(invalid).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn version_output_requires_exact_command_version_and_lf() {
        assert!(validate_deny_version_output("cargo-deny 0.20.2\n", "0.20.2").is_ok());
        for invalid in [
            "cargo-deny 0.20.2",
            "cargo-deny 0.20.2\n\n",
            "cargo-deny 0.20.2 \n",
            "wrapper cargo-deny 0.20.2\n",
            "cargo-deny 0.20.3\n",
        ] {
            assert!(
                validate_deny_version_output(invalid, "0.20.2").is_err(),
                "{invalid:?}"
            );
        }
    }

    #[cfg(unix)]
    mod executable_gate {
        use std::{
            env,
            ffi::OsStr,
            fs,
            os::unix::fs::PermissionsExt,
            path::PathBuf,
            process::Command,
            sync::atomic::{AtomicU64, Ordering},
            time::{SystemTime, UNIX_EPOCH},
        };

        use super::super::run_deny_check;

        static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

        struct Fixture {
            root: PathBuf,
            bin: PathBuf,
            log: PathBuf,
        }

        impl Fixture {
            fn new(authority: Option<&[u8]>) -> Self {
                let nonce = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system clock before Unix epoch")
                    .as_nanos();
                let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
                let root = env::temp_dir().join(format!(
                    "aizign-xtask-rust-check-{}-{nonce}-{id}",
                    std::process::id()
                ));
                let bin = root.join("bin");
                let log = root.join("cargo.log");
                fs::create_dir_all(&bin).expect("create fixture directories");
                if let Some(authority) = authority {
                    fs::write(root.join(".cargo-deny-version"), authority)
                        .expect("write fixture authority");
                }

                let cargo = bin.join("cargo");
                fs::write(
                    &cargo,
                    r#"#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$AIZIGN_CARGO_LOG"
if [[ "${1-}" == "deny" && "${2-}" == "--version" ]]; then
  printf '%s\n' "$AIZIGN_FAKE_DENY_VERSION"
  exit "${AIZIGN_FAKE_DENY_EXIT:-0}"
fi
"#,
                )
                .expect("write fake cargo");
                let mut permissions = fs::metadata(&cargo).expect("stat fake cargo").permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(&cargo, permissions).expect("make fake cargo executable");

                Self { root, bin, log }
            }

            fn env<'a>(&'a self, version: &'a str) -> Vec<(&'a str, String)> {
                let inherited_path = env::var_os("PATH").unwrap_or_default();
                let path = format!(
                    "{}:{}",
                    self.bin.display(),
                    inherited_path.to_string_lossy()
                );
                self.env_with_path(version, path)
            }

            fn env_with_path<'a>(
                &'a self,
                version: &'a str,
                path: String,
            ) -> Vec<(&'a str, String)> {
                vec![
                    ("PATH", path),
                    ("AIZIGN_CARGO_LOG", self.log.to_string_lossy().into_owned()),
                    ("AIZIGN_FAKE_DENY_VERSION", version.to_owned()),
                    ("AIZIGN_FAKE_DENY_EXIT", "0".to_owned()),
                ]
            }

            fn assert_no_deny_check(&self) {
                let log = fs::read_to_string(&self.log).unwrap_or_default();
                assert!(!log.lines().any(|line| line == "deny check"), "{log}");
            }

            fn assert_deny_check(&self) {
                let log = fs::read_to_string(&self.log).expect("read fake cargo log");
                assert!(log.lines().any(|line| line == "deny check"), "{log}");
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.root);
            }
        }

        fn run_with_fixture(fixture: &Fixture, version: &str) -> Result<(), String> {
            let values = fixture.env(version);
            run_with_values(fixture, &values)
        }

        fn run_with_path(fixture: &Fixture, version: &str, path: String) -> Result<(), String> {
            let values = fixture.env_with_path(version, path);
            run_with_values(fixture, &values)
        }

        fn run_with_values(fixture: &Fixture, values: &[(&str, String)]) -> Result<(), String> {
            let env: Vec<(&str, &str)> = values
                .iter()
                .map(|(name, value)| (*name, value.as_str()))
                .collect();
            run_deny_check(&fixture.root, &env)
        }

        fn write_executable(path: &std::path::Path, contents: &str) {
            fs::write(path, contents).expect("write executable fixture");
            let mut permissions = fs::metadata(path)
                .expect("stat executable fixture")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("make fixture executable");
        }

        fn executable_on_path(program: &str, path: &OsStr) -> PathBuf {
            env::split_paths(path)
                .map(|directory| directory.join(program))
                .find(|candidate| candidate.is_file())
                .unwrap_or_else(|| panic!("{program} was not found on PATH"))
        }

        #[test]
        fn missing_authority_fails_before_audit() {
            let fixture = Fixture::new(None);

            let error = run_with_fixture(&fixture, "cargo-deny 0.20.2").unwrap_err();

            assert!(error.contains(".cargo-deny-version"), "{error}");
            assert!(error.contains("cargo-deny version authority"), "{error}");
            assert!(
                error.contains(
                    "cargo install cargo-deny --version \"$(bash .github/scripts/read-cargo-deny-version.sh)\" --locked"
                ),
                "{error}"
            );
            fixture.assert_no_deny_check();
        }

        #[test]
        fn missing_cargo_deny_fails_before_audit() {
            let fixture = Fixture::new(Some(b"0.20.2\n"));
            fs::remove_file(fixture.bin.join("cargo")).expect("remove fake cargo");

            let error = run_with_path(
                &fixture,
                "cargo-deny 0.20.2",
                fixture.bin.to_string_lossy().into_owned(),
            )
            .unwrap_err();

            assert!(
                error.contains("failed to start `cargo deny --version`"),
                "{error}"
            );
            assert!(
                error.contains("cargo install cargo-deny --version 0.20.2 --locked"),
                "{error}"
            );
            fixture.assert_no_deny_check();
        }

        #[test]
        fn malformed_authority_fails_before_audit() {
            let fixture = Fixture::new(Some(b"0.20.2"));

            let error = run_with_fixture(&fixture, "cargo-deny 0.20.2").unwrap_err();

            assert!(error.contains("terminal LF"), "{error}");
            assert!(
                error.contains(
                    "cargo install cargo-deny --version \"$(bash .github/scripts/read-cargo-deny-version.sh)\" --locked"
                ),
                "{error}"
            );
            fixture.assert_no_deny_check();
        }

        #[test]
        fn shell_authority_reader_rejects_trailing_bytes() {
            let fixture = Fixture::new(Some(b"0.20.2\ntrailing"));
            let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join(".github/scripts/read-cargo-deny-version.sh");
            let output = Command::new("bash")
                .arg(helper)
                .arg(fixture.root.join(".cargo-deny-version"))
                .output()
                .expect("run cargo-deny authority reader");

            assert!(!output.status.success());
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains("exactly one LF byte"), "{stderr}");
        }

        #[test]
        fn shell_authority_reader_returns_exact_valid_value() {
            let fixture = Fixture::new(Some(b"0.20.2\n"));
            let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join(".github/scripts/read-cargo-deny-version.sh");
            let output = Command::new("bash")
                .arg(helper)
                .arg(fixture.root.join(".cargo-deny-version"))
                .output()
                .expect("run cargo-deny authority reader");

            assert!(output.status.success());
            assert_eq!(output.stdout, b"0.20.2\n");
        }

        #[test]
        fn non_zero_version_command_fails_before_audit() {
            let fixture = Fixture::new(Some(b"0.20.2\n"));
            let mut values = fixture.env("cargo-deny 0.20.2");
            values[3].1 = "42".to_owned();

            let error = run_with_values(&fixture, &values).unwrap_err();

            assert!(error.contains("cargo deny --version"), "{error}");
            assert!(error.contains("exit status: 42"), "{error}");
            fixture.assert_no_deny_check();
        }

        #[test]
        fn wrong_first_path_executable_fails_before_audit() {
            let fixture = Fixture::new(Some(b"0.20.2\n"));

            let error = run_with_fixture(&fixture, "cargo-deny 0.20.1").unwrap_err();

            assert!(error.contains("cargo-deny 0.20.1"), "{error}");
            assert!(
                error.contains("cargo install cargo-deny --version 0.20.2 --locked"),
                "{error}"
            );
            fixture.assert_no_deny_check();
            let log = fs::read_to_string(&fixture.log).expect("read fake cargo log");
            assert!(log.lines().any(|line| line == "deny --version"), "{log}");
        }

        #[test]
        fn wrong_first_path_cargo_deny_fails_before_audit() {
            let fixture = Fixture::new(Some(b"0.20.2\n"));
            let inherited_path = env::var_os("PATH").unwrap_or_default();
            let real_cargo = executable_on_path("cargo", &inherited_path);
            let bad_bin = fixture.root.join("bad-cargo-deny");
            let good_bin = fixture.root.join("good-cargo-deny");
            fs::create_dir_all(&bad_bin).expect("create bad cargo-deny directory");
            fs::create_dir_all(&good_bin).expect("create good cargo-deny directory");
            write_executable(
                &bad_bin.join("cargo-deny"),
                r#"#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$AIZIGN_DENY_LOG"
                    if [[ "${1-}" == "deny" && "${2-}" == "--version" ]]; then
                      printf '%s\n' 'cargo-deny 0.20.1'
                    fi
"#,
            );
            write_executable(
                &good_bin.join("cargo-deny"),
                r#"#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$AIZIGN_DENY_LOG"
                    if [[ "${1-}" == "deny" && "${2-}" == "--version" ]]; then
                      printf '%s\n' 'cargo-deny 0.20.2'
                    fi
"#,
            );

            let mut path_entries = vec![
                bad_bin,
                good_bin,
                real_cargo
                    .parent()
                    .expect("cargo has a parent directory")
                    .to_path_buf(),
            ];
            path_entries.extend(env::split_paths(&inherited_path));
            let path = env::join_paths(path_entries)
                .expect("join competing cargo-deny PATH entries")
                .to_string_lossy()
                .into_owned();
            let mut values = fixture.env_with_path("unused", path);
            let deny_log = fixture.root.join("cargo-deny.log");
            values.push(("AIZIGN_DENY_LOG", deny_log.to_string_lossy().into_owned()));

            let error = run_with_values(&fixture, &values).unwrap_err();

            assert!(error.contains("cargo-deny 0.20.1"), "{error}");
            fixture.assert_no_deny_check();
            let log = fs::read_to_string(deny_log).expect("read cargo-deny log");
            assert_eq!(log.lines().collect::<Vec<_>>(), vec!["deny --version"]);
        }

        #[test]
        fn exact_version_allows_the_audit_command() {
            let fixture = Fixture::new(Some(b"0.20.2\n"));

            run_with_fixture(&fixture, "cargo-deny 0.20.2").expect("exact version passes");

            fixture.assert_deny_check();
        }
    }
}
