//! Loader for the language-neutral fixtures under `spec/conformance`.
//!
//! Returns raw frames and expectations only, so any crate can run them
//! against its own decoder without this crate knowing the decoder's types.

use std::fs;
use std::path::{Path, PathBuf};

/// Which contract a fixture belongs to: one of the two wire directions, the
/// durable journal record format, or the store commit document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// Frames an adapter sends to `aizign`.
    Request,
    /// Frames `aizign` sends back.
    Response,
    /// Lines of the durable control journal (`spec/journal/v1`).
    Journal,
    /// Writer-published committed-prefix metadata (`spec/store/v1`).
    Store,
}

impl Direction {
    const fn dir_name(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Response => "response",
            Self::Journal => "journal",
            Self::Store => "store",
        }
    }
}

/// A frame every decoder must accept.
#[derive(Clone, Debug)]
pub struct ValidFixture {
    /// File stem, for messages.
    pub name: String,
    /// The frame bytes, without a trailing newline.
    pub frame: Vec<u8>,
}

/// A frame every decoder must reject in the same way.
#[derive(Clone, Debug)]
pub struct InvalidFixture {
    /// File stem, for messages.
    pub name: String,
    /// The frame bytes, without a trailing newline.
    pub frame: Vec<u8>,
    /// The stable error code the decoder must return.
    pub code: String,
    /// The `requestId` the Protocol decoder must recover (`None` means null).
    pub request_id: Option<String>,
    /// The `kind` the Protocol decoder must recover (`None` means null).
    pub kind: Option<String>,
    /// Expected bootstrap or accepted-operation response stage for Protocol.
    pub response_stage: Option<String>,
    /// Exact numeric version selected/expected at that stage for Protocol.
    pub response_version: Option<u32>,
}

/// The `spec/conformance` directory of this repository.
///
/// # Panics
///
/// Panics if the directory does not exist; the fixtures are part of the
/// repository, so that is a broken checkout, not a test condition.
#[must_use]
pub fn root() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/conformance");
    assert!(root.is_dir(), "missing {}", root.display());
    root
}

/// Every valid fixture for `direction`, sorted by name.
#[must_use]
pub fn valid(direction: Direction) -> Vec<ValidFixture> {
    let dir = root().join("valid").join(direction.dir_name());
    sorted_files(&dir, ".frame")
        .into_iter()
        .map(|(name, path)| ValidFixture {
            name,
            frame: fs::read(path).expect("read frame"),
        })
        .collect()
}

/// Every invalid fixture for `direction`, sorted by name.
#[must_use]
pub fn invalid(direction: Direction) -> Vec<InvalidFixture> {
    let dir = root().join("invalid").join(direction.dir_name());
    sorted_files(&dir, ".frame")
        .into_iter()
        .map(|(name, path)| {
            let expect_path = dir.join(format!("{name}.expect.json"));
            let expect: serde_json::Value = serde_json::from_slice(
                &fs::read(&expect_path)
                    .unwrap_or_else(|_| panic!("missing {}", expect_path.display())),
            )
            .expect("expectation is JSON");
            let string = |key: &str| {
                expect
                    .get(key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            };
            InvalidFixture {
                name,
                frame: fs::read(path).expect("read frame"),
                code: string("code").expect("expectation has a code"),
                request_id: string("requestId"),
                kind: string("kind"),
                response_stage: string("responseStage"),
                response_version: expect
                    .get("responseVersion")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok()),
            }
        })
        .collect()
}

fn sorted_files(dir: &Path, suffix: &str) -> Vec<(String, PathBuf)> {
    let mut files: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .unwrap_or_else(|_| panic!("missing {}", dir.display()))
        .map(|entry| entry.expect("dir entry").path())
        .filter_map(|path| {
            let file_name = path.file_name()?.to_string_lossy().into_owned();
            let stem = file_name.strip_suffix(suffix)?.to_owned();
            Some((stem, path))
        })
        .collect();
    files.sort();
    assert!(
        !files.is_empty(),
        "no {suffix} fixtures in {}",
        dir.display()
    );
    files
}
