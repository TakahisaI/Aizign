//! Single production OS-operation adapter for store-v2 publication.

use std::fs::{File, OpenOptions};
use std::io::{Seek as _, SeekFrom, Write as _};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
// The accepted checkpoint fixes these eleven complete-event names verbatim.
#[allow(clippy::enum_variant_names)]
pub(crate) enum DurabilityPoint {
    PreparedWriteComplete,
    PreparedBarrierComplete,
    JournalRecordWriteComplete,
    JournalBarrierComplete,
    CommitTemporaryWriteComplete,
    CommitTemporaryBarrierComplete,
    CommitRenameComplete,
    CommitDirectoryBarrierComplete,
    CleanWriteComplete,
    CleanBarrierComplete,
    DurableAppendComplete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PrimitiveEvent {
    pub(crate) operation: &'static str,
    pub(crate) artifact: &'static str,
    pub(crate) durability_point: Option<DurabilityPoint>,
    pub(crate) byte_count: Option<usize>,
}

impl PrimitiveEvent {
    pub(crate) const fn evidence(operation: &'static str, artifact: &'static str) -> Self {
        Self {
            operation,
            artifact,
            durability_point: None,
            byte_count: None,
        }
    }

    const fn durable(point: DurabilityPoint) -> Self {
        let (operation, artifact) = match point {
            DurabilityPoint::PreparedWriteComplete | DurabilityPoint::CleanWriteComplete => {
                ("write-complete", "publish-witness")
            }
            DurabilityPoint::PreparedBarrierComplete | DurabilityPoint::CleanBarrierComplete => {
                ("file-barrier-complete", "publish-witness")
            }
            DurabilityPoint::JournalRecordWriteComplete => ("write-complete", "journal"),
            DurabilityPoint::JournalBarrierComplete => ("file-barrier-complete", "journal"),
            DurabilityPoint::CommitTemporaryWriteComplete => ("write-complete", "commit-temporary"),
            DurabilityPoint::CommitTemporaryBarrierComplete => {
                ("file-barrier-complete", "commit-temporary")
            }
            DurabilityPoint::CommitRenameComplete => ("rename-complete", "commit"),
            DurabilityPoint::CommitDirectoryBarrierComplete => {
                ("directory-barrier-complete", "state-directory")
            }
            DurabilityPoint::DurableAppendComplete => ("durable-append-complete", "journal"),
        };
        Self {
            operation,
            artifact,
            durability_point: Some(point),
            byte_count: None,
        }
    }
}

#[cfg_attr(
    not(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    )),
    allow(dead_code)
)]
pub(crate) trait DurabilityOps {
    fn before(&mut self, _point: DurabilityPoint) -> std::io::Result<()> {
        Ok(())
    }

    fn after(&mut self, _point: DurabilityPoint) -> std::io::Result<()> {
        Ok(())
    }

    fn primitive_complete(&mut self, _event: PrimitiveEvent) -> std::io::Result<()> {
        Ok(())
    }

    fn create_state_directory(&mut self, path: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt as _;
            std::fs::DirBuilder::new().mode(0o700).create(path)?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir(path)?;
        self.primitive_complete(PrimitiveEvent::evidence(
            "create-complete",
            "state-directory",
        ))
    }

    fn normalize_state_directory(&mut self, path: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        }
        self.primitive_complete(PrimitiveEvent::evidence(
            "permissions-normalized",
            "state-directory",
        ))
    }

    fn open_private_writable(
        &mut self,
        path: &Path,
        create_new: bool,
        append: bool,
    ) -> std::io::Result<File> {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(!append)
            .append(append)
            .create_new(create_new);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            const O_CLOEXEC: i32 = 0o2_000_000;
            const O_NOFOLLOW: i32 = 0o400_000;
            const O_NONBLOCK: i32 = 0o4_000;
            options
                .mode(0o600)
                .custom_flags(O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
        }
        options.open(path)
    }

    fn normalize_private_file(
        &mut self,
        file: &File,
        artifact: &'static str,
    ) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        self.primitive_complete(PrimitiveEvent::evidence("permissions-normalized", artifact))
    }

    fn replace_private_writable(
        &mut self,
        path: &Path,
        remove_stale: bool,
        artifact: &'static str,
    ) -> std::io::Result<File> {
        if remove_stale {
            std::fs::remove_file(path)?;
        }
        let file = self.open_private_writable(path, true, false)?;
        self.primitive_complete(PrimitiveEvent::evidence("open-complete", artifact))?;
        self.normalize_private_file(&file, artifact)?;
        Ok(file)
    }

    fn rewrite_file(
        &mut self,
        file: &mut File,
        bytes: &[u8],
        point: DurabilityPoint,
    ) -> std::io::Result<()> {
        self.before(point)?;
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(bytes)?;
        self.after(point)?;
        self.primitive_complete(PrimitiveEvent::durable(point))
    }

    fn append_file(
        &mut self,
        file: &mut File,
        bytes: &[u8],
        point: DurabilityPoint,
    ) -> std::io::Result<()> {
        self.before(point)?;
        #[cfg(all(
            test,
            target_os = "linux",
            target_arch = "x86_64",
            target_env = "gnu",
            target_pointer_width = "64"
        ))]
        if let Some(prefix) = crate::crash_harness::selected_partial_write(bytes.len())? {
            file.write_all(&bytes[..prefix])?;
            self.primitive_complete(PrimitiveEvent {
                operation: "partial-write-stopped",
                artifact: "journal",
                durability_point: None,
                byte_count: Some(prefix),
            })?;
            return Err(std::io::Error::other(
                "partial-write crash helper was released unexpectedly",
            ));
        }
        file.write_all(bytes)?;
        self.after(point)?;
        self.primitive_complete(PrimitiveEvent::durable(point))
    }

    fn write_file(
        &mut self,
        file: &mut File,
        bytes: &[u8],
        point: DurabilityPoint,
    ) -> std::io::Result<()> {
        self.before(point)?;
        file.write_all(bytes)?;
        self.after(point)?;
        self.primitive_complete(PrimitiveEvent::durable(point))
    }

    fn barrier_file(&mut self, file: &File, point: DurabilityPoint) -> std::io::Result<()> {
        self.before(point)?;
        file.sync_all()?;
        self.after(point)?;
        self.primitive_complete(PrimitiveEvent::durable(point))
    }

    fn rename(&mut self, from: &Path, to: &Path, point: DurabilityPoint) -> std::io::Result<()> {
        self.before(point)?;
        std::fs::rename(from, to)?;
        self.after(point)?;
        self.primitive_complete(PrimitiveEvent::durable(point))
    }

    fn barrier_directory(
        &mut self,
        directory: &File,
        point: DurabilityPoint,
    ) -> std::io::Result<()> {
        self.before(point)?;
        directory.sync_all()?;
        self.after(point)?;
        self.primitive_complete(PrimitiveEvent::durable(point))
    }

    fn barrier_file_untracked(&mut self, file: &File) -> std::io::Result<()> {
        file.sync_all()
    }

    fn barrier_file_evidence(
        &mut self,
        file: &File,
        artifact: &'static str,
    ) -> std::io::Result<()> {
        self.barrier_file_untracked(file)?;
        self.primitive_complete(PrimitiveEvent::evidence("file-barrier-complete", artifact))
    }

    fn barrier_directory_untracked(&mut self, directory: &File) -> std::io::Result<()> {
        directory.sync_all()
    }

    fn barrier_directory_evidence(
        &mut self,
        directory: &File,
        artifact: &'static str,
    ) -> std::io::Result<()> {
        self.barrier_directory_untracked(directory)?;
        self.primitive_complete(PrimitiveEvent::evidence(
            "directory-barrier-complete",
            artifact,
        ))
    }

    fn note(&mut self, point: DurabilityPoint) -> std::io::Result<()> {
        self.before(point)?;
        self.after(point)?;
        self.primitive_complete(PrimitiveEvent::durable(point))
    }
}

#[derive(Default)]
pub(crate) struct ProductionDurability;

impl DurabilityOps for ProductionDurability {
    #[cfg(all(
        test,
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    ))]
    fn primitive_complete(&mut self, event: PrimitiveEvent) -> std::io::Result<()> {
        crate::crash_harness::primitive_completed(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder(Vec<DurabilityPoint>);

    impl DurabilityOps for Recorder {
        fn after(&mut self, point: DurabilityPoint) -> std::io::Result<()> {
            self.0.push(point);
            Ok(())
        }
    }

    #[test]
    fn adapter_records_the_same_operation_it_executes() {
        let dir =
            std::env::temp_dir().join(format!("aizign-durability-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let mut file = File::create(dir.join("data")).unwrap();
        let mut recorder = Recorder::default();
        recorder
            .write_file(
                &mut file,
                b"x",
                DurabilityPoint::CommitTemporaryWriteComplete,
            )
            .unwrap();
        assert_eq!(recorder.0, [DurabilityPoint::CommitTemporaryWriteComplete]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
