//! Closed store-metadata v1 document for the writer-published JSONL prefix.

use aizign_engine::{JournalError, MAX_JOURNAL_ENTRIES};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::json_member::has_duplicate_members;

/// Store-layout metadata version implemented by this crate.
pub const STORE_METADATA_VERSION: u64 = 1;
/// Maximum serialized size of `workflow.commit.json`.
pub const MAX_COMMIT_METADATA_BYTES: u64 = 4 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CommitPoint {
    pub(crate) committed_bytes: u64,
    pub(crate) committed_entries: u64,
    pub(crate) digest: [u8; 32],
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CommitDto {
    store_version: u64,
    committed_bytes: u64,
    committed_entries: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionProbe {
    #[serde(default)]
    store_version: Option<u64>,
}

fn corrupt(detail: impl Into<String>) -> JournalError {
    JournalError::Corrupt {
        detail: detail.into(),
    }
}

impl CommitPoint {
    pub(crate) fn empty() -> Self {
        Self {
            committed_bytes: 0,
            committed_entries: 0,
            digest: hash_bytes(&[]),
        }
    }

    pub(crate) fn for_prefix(prefix: &[u8], committed_entries: u64) -> Self {
        Self {
            committed_bytes: prefix.len() as u64,
            committed_entries,
            digest: hash_bytes(prefix),
        }
    }

    pub(crate) fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(&CommitDto {
            store_version: STORE_METADATA_VERSION,
            committed_bytes: self.committed_bytes,
            committed_entries: self.committed_entries,
            sha256: encode_hex(&self.digest),
        })
        .expect("commit metadata serializes")
    }

    pub(crate) fn decode(bytes: &[u8], max_journal_bytes: u64) -> Result<Self, JournalError> {
        if bytes.len() as u64 > MAX_COMMIT_METADATA_BYTES {
            return Err(corrupt("commit metadata exceeds its byte bound"));
        }
        let text = core::str::from_utf8(bytes)
            .map_err(|_| corrupt("commit metadata is not UTF-8 JSON"))?;
        if has_duplicate_members(text) {
            return Err(corrupt("commit metadata repeats a JSON member"));
        }
        let probe: VersionProbe = serde_json::from_slice(bytes)
            .map_err(|_| corrupt("commit metadata is not a JSON object"))?;
        match probe.store_version {
            Some(STORE_METADATA_VERSION) => {}
            Some(found) => return Err(JournalError::SchemaUnsupported { found }),
            None => return Err(corrupt("commit metadata is missing storeVersion")),
        }
        let dto: CommitDto = serde_json::from_slice(bytes)
            .map_err(|error| corrupt(format!("invalid commit metadata: {error}")))?;
        if dto.committed_bytes > max_journal_bytes {
            return Err(corrupt("committedBytes exceeds the journal byte bound"));
        }
        if dto.committed_entries > MAX_JOURNAL_ENTRIES as u64 {
            return Err(JournalError::BoundExceeded {
                max: MAX_JOURNAL_ENTRIES,
            });
        }
        let digest = decode_hex(&dto.sha256)
            .ok_or_else(|| corrupt("sha256 must be exactly 64 lowercase hexadecimal digits"))?;
        Ok(Self {
            committed_bytes: dto.committed_bytes,
            committed_entries: dto.committed_entries,
            digest,
        })
    }
}

pub(crate) fn hash_bytes(bytes: &[u8]) -> [u8; 32] {
    hash_chunks(bytes.chunks(8192))
}

fn hash_chunks<'a>(chunks: impl IntoIterator<Item = &'a [u8]>) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for chunk in chunks {
        hasher.update(chunk);
    }
    hasher.finalize().into()
}

fn encode_hex(digest: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn decode_hex(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(decoded)
}

const fn nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_answers_match() {
        assert_eq!(
            encode_hex(&hash_bytes(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            encode_hex(&hash_bytes(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn chunking_does_not_change_the_digest() {
        let bytes = b"the committed prefix is hashed incrementally";
        assert_eq!(hash_bytes(bytes), hash_chunks(bytes.chunks(3)));
    }

    #[test]
    fn exact_prefix_excludes_an_unpublished_tail() {
        let bytes = b"committedtail";
        assert_eq!(hash_bytes(&bytes[..9]), hash_bytes(b"committed"));
        assert_ne!(hash_bytes(bytes), hash_bytes(b"committed"));
    }

    #[test]
    fn closed_metadata_round_trips_and_rejects_mismatch_shapes() {
        let point = CommitPoint::for_prefix(b"abc", 1);
        assert_eq!(
            CommitPoint::decode(&point.encode(), 100).expect("decode"),
            point
        );
        assert!(matches!(
            CommitPoint::decode(br#"{"storeVersion":2,"committedBytes":0,"committedEntries":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}"#, 100),
            Err(JournalError::SchemaUnsupported { found: 2 })
        ));
        assert!(matches!(
            CommitPoint::decode(br#"{"storeVersion":1,"committedBytes":0,"committedEntries":0,"sha256":"E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"}"#, 100),
            Err(JournalError::Corrupt { .. })
        ));
    }
}
