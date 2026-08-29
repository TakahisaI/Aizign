//! Fd-bound qualification for the sole supported v0.1 store profile.

use std::fs::File;

use aizign_engine::JournalError;
#[cfg(all(
    test,
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
use serde::Serialize;

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
use crate::mountinfo;

#[cfg(all(
    test,
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
pub(crate) const PROFILE_NAME: &str = "linux-x86_64-gnu-ext4-local-v1";
#[cfg(all(
    test,
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
pub(crate) const PROFILE_HARNESS_VERSION: u64 = 1;
const EXT_FAMILY_MAGIC: u64 = 0xef53;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProfileObservation {
    pub(crate) mount_id: u64,
    pub(crate) device_major: u32,
    pub(crate) device_minor: u32,
    pub(crate) filesystem_type: String,
    pub(crate) filesystem_magic: u64,
    pub(crate) mount_read_only: bool,
    pub(crate) superblock_read_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct QualifiedProfile(ProfileObservation);

#[cfg(all(
    test,
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileEvidence {
    profile: &'static str,
    target_triple: &'static str,
    pointer_width: u32,
    kernel_release: String,
    filesystem_type: String,
    filesystem_magic: String,
    mount_read_only: bool,
    superblock_read_only: bool,
    device_matches: bool,
    harness_version: u64,
}

pub(crate) trait ProfileOps {
    fn observe(&mut self, opened: &File) -> Result<ProfileObservation, JournalError>;
}

#[derive(Default)]
pub(crate) struct ProductionProfile;

fn unavailable(detail: impl Into<String>) -> JournalError {
    JournalError::Unavailable {
        detail: detail.into(),
    }
}

pub(crate) fn qualify_directory(
    opened: &File,
    ops: &mut dyn ProfileOps,
) -> Result<QualifiedProfile, JournalError> {
    let observation = ops.observe(opened)?;
    validate_observation(&observation)?;
    Ok(QualifiedProfile(observation))
}

pub(crate) fn require_same_profile(
    opened: &File,
    expected: &QualifiedProfile,
    ops: &mut dyn ProfileOps,
) -> Result<(), JournalError> {
    let actual = ops.observe(opened)?;
    validate_observation(&actual)?;
    if actual.mount_id != expected.0.mount_id
        || actual.device_major != expected.0.device_major
        || actual.device_minor != expected.0.device_minor
        || actual.filesystem_type != expected.0.filesystem_type
        || actual.filesystem_magic != expected.0.filesystem_magic
    {
        return Err(unavailable(
            "opened artifact does not match the qualified store profile",
        ));
    }
    Ok(())
}

#[cfg(all(
    test,
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
pub(crate) fn profile_evidence(profile: &QualifiedProfile) -> ProfileEvidence {
    ProfileEvidence {
        profile: PROFILE_NAME,
        target_triple: "x86_64-unknown-linux-gnu",
        pointer_width: 64,
        kernel_release: kernel_release(),
        filesystem_type: profile.0.filesystem_type.clone(),
        filesystem_magic: format!("0x{:x}", profile.0.filesystem_magic),
        mount_read_only: profile.0.mount_read_only,
        superblock_read_only: profile.0.superblock_read_only,
        device_matches: true,
        harness_version: PROFILE_HARNESS_VERSION,
    }
}

fn validate_observation(observation: &ProfileObservation) -> Result<(), JournalError> {
    if observation.mount_id == 0 {
        return Err(unavailable("opened directory has an unusable mount ID"));
    }
    if observation.filesystem_type != "ext4" {
        return Err(unavailable("opened directory is not on exact ext4"));
    }
    if observation.mount_read_only || observation.superblock_read_only {
        return Err(unavailable("opened directory is on read-only storage"));
    }
    if observation.filesystem_magic != EXT_FAMILY_MAGIC {
        return Err(unavailable(
            "opened directory filesystem magic does not corroborate ext4",
        ));
    }
    Ok(())
}

#[cfg(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
impl ProfileOps for ProductionProfile {
    fn observe(&mut self, opened: &File) -> Result<ProfileObservation, JournalError> {
        use rustix::fs::{AtFlags, StatxFlags};

        let stat = rustix::fs::statx(
            opened,
            "",
            AtFlags::EMPTY_PATH,
            StatxFlags::BASIC_STATS | StatxFlags::MNT_ID,
        )
        .map_err(|error| unavailable(format!("cannot qualify opened store directory: {error}")))?;
        let returned = StatxFlags::from_bits_retain(stat.stx_mask);
        if !returned.contains(StatxFlags::MNT_ID) {
            return Err(unavailable(
                "opened store directory did not return STATX_MNT_ID",
            ));
        }
        let mount = mountinfo::read_exact_mount(stat.stx_mnt_id)?;
        if stat.stx_dev_major != mount.device_major || stat.stx_dev_minor != mount.device_minor {
            return Err(unavailable(
                "opened directory device does not match its mount information",
            ));
        }
        let filesystem = rustix::fs::fstatfs(opened)
            .map_err(|error| unavailable(format!("cannot inspect filesystem magic: {error}")))?;
        Ok(ProfileObservation {
            mount_id: mount.mount_id,
            device_major: stat.stx_dev_major,
            device_minor: stat.stx_dev_minor,
            filesystem_type: mount.filesystem_type,
            filesystem_magic: filesystem.f_type as u64,
            mount_read_only: mount.mount_read_only,
            superblock_read_only: mount.superblock_read_only,
        })
    }
}

#[cfg(not(all(
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
)))]
impl ProfileOps for ProductionProfile {
    fn observe(&mut self, _opened: &File) -> Result<ProfileObservation, JournalError> {
        Err(unavailable(
            "this target has no verified store-profile implementation",
        ))
    }
}

#[cfg(all(
    test,
    target_os = "linux",
    target_arch = "x86_64",
    target_env = "gnu",
    target_pointer_width = "64"
))]
fn kernel_release() -> String {
    const MAX_KERNEL_RELEASE_BYTES: u64 = 256;
    std::fs::read("/proc/sys/kernel/osrelease")
        .ok()
        .filter(|bytes| bytes.len() as u64 <= MAX_KERNEL_RELEASE_BYTES)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unavailable".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(ProfileObservation);

    impl ProfileOps for Fixed {
        fn observe(&mut self, _opened: &File) -> Result<ProfileObservation, JournalError> {
            Ok(self.0.clone())
        }
    }

    fn valid() -> ProfileObservation {
        ProfileObservation {
            mount_id: 9,
            device_major: 8,
            device_minor: 1,
            filesystem_type: "ext4".to_owned(),
            filesystem_magic: EXT_FAMILY_MAGIC,
            mount_read_only: false,
            superblock_read_only: false,
        }
    }

    #[test]
    fn closed_profile_rejects_each_fail_closed_boundary() {
        let file = std::fs::File::open(".").unwrap();
        assert!(qualify_directory(&file, &mut Fixed(valid())).is_ok());
        let mut invalid = valid();
        invalid.filesystem_type = "fuseblk".to_owned();
        assert!(qualify_directory(&file, &mut Fixed(invalid)).is_err());
        let mut invalid = valid();
        invalid.mount_read_only = true;
        assert!(qualify_directory(&file, &mut Fixed(invalid)).is_err());
        let mut invalid = valid();
        invalid.filesystem_magic = 0;
        assert!(qualify_directory(&file, &mut Fixed(invalid)).is_err());
    }

    #[cfg(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu",
        target_pointer_width = "64"
    ))]
    #[test]
    fn supported_profile_evidence_uses_the_production_qualified_state_directory() {
        let temporary = aizign_testkit::TempDir::new();
        let state = temporary.state();
        drop(crate::journal::JsonlJournal::open(&state).expect("production-qualified state"));
        let opened = File::open(&state).expect("open actual test state directory");
        let qualified = qualify_directory(&opened, &mut ProductionProfile)
            .expect("requalify actual test state directory");
        let evidence = serde_json::to_value(profile_evidence(&qualified)).expect("evidence JSON");
        let keys = evidence.as_object().expect("closed evidence object");
        assert_eq!(keys.len(), 10);
        assert_eq!(evidence["profile"], PROFILE_NAME);
        assert_eq!(evidence["targetTriple"], "x86_64-unknown-linux-gnu");
        assert_eq!(evidence["pointerWidth"], 64);
        assert_eq!(evidence["filesystemType"], "ext4");
        assert_eq!(evidence["filesystemMagic"], "0xef53");
        assert_eq!(evidence["mountReadOnly"], false);
        assert_eq!(evidence["superblockReadOnly"], false);
        assert_eq!(evidence["deviceMatches"], true);
        assert_eq!(evidence["harnessVersion"], PROFILE_HARNESS_VERSION);
        println!(
            "AIZIGN_STORE_PROFILE_EVIDENCE={}",
            serde_json::to_string(&evidence).expect("bounded evidence")
        );
    }
}
