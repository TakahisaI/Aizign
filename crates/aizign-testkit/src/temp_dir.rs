//! A unique, self-removing directory for tests that need a state directory.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh directory under the system temp directory, removed on drop.
#[derive(Debug)]
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// Creates a new empty directory.
    ///
    /// # Panics
    ///
    /// Panics if the directory cannot be created.
    #[must_use]
    pub fn new() -> Self {
        let unique = format!(
            "aizign-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    /// The directory itself.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A not-yet-created candidate `aizign` state path.
    ///
    /// This helper establishes no production storage-profile support. The
    /// store's fd-bound qualifier remains authoritative for the returned path.
    #[must_use]
    pub fn state(&self) -> PathBuf {
        self.path.join("state")
    }
}

impl Default for TempDir {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
