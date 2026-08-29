//! Single production OS-operation adapter for store-v2 publication.

use std::fs::File;
use std::io::{Seek as _, SeekFrom, Write as _};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DurabilityPoint {
    #[cfg(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    ))]
    StateDirectoryCreate,
    #[cfg(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    ))]
    StateDirectoryBarrier,
    #[cfg(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    ))]
    ParentDirectoryBarrier,
    LockFileCreate,
    LockFileBarrier,
    JournalFileCreate,
    JournalFileBarrier,
    ArtifactDirectoryBarrier,
    CommitTemporaryCreate,
    CommitTemporaryWriteComplete,
    CommitTemporaryBarrierComplete,
    CommitRenameComplete,
    CommitDirectoryBarrierComplete,
    WitnessCreate,
    PreparedWriteComplete,
    PreparedBarrierComplete,
    WitnessDirectoryBarrierComplete,
    JournalRecordWriteComplete,
    JournalBarrierComplete,
    CleanWriteComplete,
    CleanBarrierComplete,
    DurableAppendComplete,
}

pub(crate) trait DurabilityOps {
    fn before(&mut self, _point: DurabilityPoint) -> std::io::Result<()> {
        Ok(())
    }

    fn after(&mut self, _point: DurabilityPoint) -> std::io::Result<()> {
        Ok(())
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
        self.after(point)
    }

    fn append_file(
        &mut self,
        file: &mut File,
        bytes: &[u8],
        point: DurabilityPoint,
    ) -> std::io::Result<()> {
        self.before(point)?;
        file.write_all(bytes)?;
        self.after(point)
    }

    fn write_file(
        &mut self,
        file: &mut File,
        bytes: &[u8],
        point: DurabilityPoint,
    ) -> std::io::Result<()> {
        self.before(point)?;
        file.write_all(bytes)?;
        self.after(point)
    }

    fn barrier_file(&mut self, file: &File, point: DurabilityPoint) -> std::io::Result<()> {
        self.before(point)?;
        file.sync_all()?;
        self.after(point)
    }

    fn rename(&mut self, from: &Path, to: &Path, point: DurabilityPoint) -> std::io::Result<()> {
        self.before(point)?;
        std::fs::rename(from, to)?;
        self.after(point)
    }

    fn barrier_directory(
        &mut self,
        directory: &File,
        point: DurabilityPoint,
    ) -> std::io::Result<()> {
        self.before(point)?;
        directory.sync_all()?;
        self.after(point)
    }

    fn note(&mut self, point: DurabilityPoint) -> std::io::Result<()> {
        self.before(point)?;
        self.after(point)
    }
}

#[derive(Default)]
pub(crate) struct ProductionDurability;

impl DurabilityOps for ProductionDurability {}

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
