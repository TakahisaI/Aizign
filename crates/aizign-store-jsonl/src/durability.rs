//! Single production OS-operation adapter for store-v2 publication.

use std::fs::File;
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

    fn barrier_file_untracked(&mut self, file: &File) -> std::io::Result<()> {
        file.sync_all()
    }

    fn barrier_directory_untracked(&mut self, directory: &File) -> std::io::Result<()> {
        directory.sync_all()
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
