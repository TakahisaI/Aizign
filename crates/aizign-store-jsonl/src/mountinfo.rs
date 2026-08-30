//! Bounded parser for the non-sensitive mount facts used by store profiles.

use aizign_engine::JournalError;

const MAX_MOUNTINFO_BYTES: usize = 1024 * 1024;
const MAX_MOUNTINFO_ROWS: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MountRecord {
    pub(crate) mount_id: u64,
    pub(crate) device_major: u32,
    pub(crate) device_minor: u32,
    pub(crate) filesystem_type: String,
    pub(crate) mount_read_only: bool,
    pub(crate) superblock_read_only: bool,
}

fn unavailable(detail: impl Into<String>) -> JournalError {
    JournalError::Unavailable {
        detail: detail.into(),
    }
}

pub(crate) fn read_exact_mount(mount_id: u64) -> Result<MountRecord, JournalError> {
    let bytes = std::fs::read("/proc/self/mountinfo")
        .map_err(|error| unavailable(format!("cannot read mount information: {error}")))?;
    if bytes.len() > MAX_MOUNTINFO_BYTES {
        return Err(unavailable("mount information exceeds its byte bound"));
    }
    let text = core::str::from_utf8(&bytes)
        .map_err(|_| unavailable("mount information is not UTF-8 text"))?;
    find_exact_mount(text, mount_id)
}

pub(crate) fn find_exact_mount(text: &str, mount_id: u64) -> Result<MountRecord, JournalError> {
    let mut found = None;
    let mut rows = 0_usize;
    for line in text.lines() {
        rows += 1;
        if rows > MAX_MOUNTINFO_ROWS {
            return Err(unavailable("mount information exceeds its row bound"));
        }
        let mut fields = line.split_ascii_whitespace();
        let parsed_id = parse_u64(fields.next(), "mount ID")?;
        let _parent_id = parse_u64(fields.next(), "parent mount ID")?;
        let (device_major, device_minor) = parse_device(fields.next())?;
        fields
            .next()
            .ok_or_else(|| unavailable("mount information lacks a root field"))?;
        fields
            .next()
            .ok_or_else(|| unavailable("mount information lacks a mount point"))?;
        let mount_options = fields
            .next()
            .ok_or_else(|| unavailable("mount information lacks mount options"))?;
        let mut filesystem_type = None;
        let mut super_options = None;
        while let Some(field) = fields.next() {
            if field == "-" {
                filesystem_type = fields.next();
                fields
                    .next()
                    .ok_or_else(|| unavailable("mount information lacks a source field"))?;
                super_options = fields.next();
                if fields.next().is_some() {
                    return Err(unavailable(
                        "mount information has trailing required-section fields",
                    ));
                }
                break;
            }
        }
        let filesystem_type =
            filesystem_type.ok_or_else(|| unavailable("mount information lacks a separator"))?;
        let super_options = super_options
            .ok_or_else(|| unavailable("mount information lacks superblock options"))?;

        if parsed_id != mount_id {
            continue;
        }
        if found.is_some() || mount_id == 0 {
            return Err(unavailable("mount ID is ambiguous or unusable"));
        }
        found = Some(MountRecord {
            mount_id: parsed_id,
            device_major,
            device_minor,
            filesystem_type: filesystem_type.to_owned(),
            mount_read_only: option_present(mount_options, "ro")
                || !option_present(mount_options, "rw"),
            superblock_read_only: option_present(super_options, "ro"),
        });
    }
    found.ok_or_else(|| unavailable("mount ID has no usable mount information row"))
}

fn parse_u64(value: Option<&str>, name: &str) -> Result<u64, JournalError> {
    value
        .ok_or_else(|| unavailable(format!("mount information lacks {name}")))?
        .parse()
        .map_err(|_| unavailable(format!("mount information has an invalid {name}")))
}

fn parse_device(value: Option<&str>) -> Result<(u32, u32), JournalError> {
    let value = value.ok_or_else(|| unavailable("mount information lacks a device"))?;
    let (major, minor) = value
        .split_once(':')
        .ok_or_else(|| unavailable("mount information has an invalid device"))?;
    Ok((
        major
            .parse()
            .map_err(|_| unavailable("mount information has an invalid device major"))?,
        minor
            .parse()
            .map_err(|_| unavailable("mount information has an invalid device minor"))?,
    ))
}

fn option_present(options: &str, expected: &str) -> bool {
    options.split(',').any(|option| option == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "36 25 8:1 / / rw,relatime - ext4 /dev/root rw,errors=remount-ro\n";

    #[test]
    fn keeps_only_closed_non_sensitive_mount_facts() {
        let record = find_exact_mount(SAMPLE, 36).unwrap();
        assert_eq!(record.mount_id, 36);
        assert_eq!((record.device_major, record.device_minor), (8, 1));
        assert_eq!(record.filesystem_type, "ext4");
        assert!(!record.mount_read_only);
        assert!(!record.superblock_read_only);
    }

    #[test]
    fn rejects_missing_and_ambiguous_ids() {
        assert!(find_exact_mount(SAMPLE, 99).is_err());
        let duplicate = format!("{SAMPLE}{SAMPLE}");
        assert!(find_exact_mount(&duplicate, 36).is_err());
    }
}
