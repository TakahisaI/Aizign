//! Closed store-v2 PREPARED/CLEAN publication witness.

use aizign_engine::{JournalError, MAX_JOURNAL_ENTRIES};
use serde::{Deserialize, Serialize};

use crate::commit::{STORE_METADATA_VERSION, has_noncanonical_integer_token};
use crate::json_member::has_duplicate_members;

pub(crate) const MAX_PUBLISH_METADATA_BYTES: u64 = 4 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PublishWitness {
    pub(crate) started_generation: u64,
    pub(crate) published_generation: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PublishDto {
    store_version: u64,
    started_generation: u64,
    published_generation: u64,
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

impl PublishWitness {
    pub(crate) const fn initializing() -> Self {
        Self {
            started_generation: 1,
            published_generation: 0,
        }
    }

    pub(crate) const fn clean(generation: u64) -> Self {
        Self {
            started_generation: generation,
            published_generation: generation,
        }
    }

    pub(crate) const fn prepared(next_generation: u64) -> Self {
        Self {
            started_generation: next_generation,
            published_generation: next_generation - 1,
        }
    }

    pub(crate) const fn is_clean(self) -> bool {
        self.started_generation == self.published_generation
    }

    pub(crate) const fn is_initializing(self) -> bool {
        self.started_generation == 1 && self.published_generation == 0
    }

    pub(crate) const fn is_prepared_successor(self) -> bool {
        self.published_generation > 0 && self.started_generation == self.published_generation + 1
    }

    pub(crate) fn encode(self) -> Vec<u8> {
        serde_json::to_vec(&PublishDto {
            store_version: STORE_METADATA_VERSION,
            started_generation: self.started_generation,
            published_generation: self.published_generation,
        })
        .expect("publication witness serializes")
    }

    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, JournalError> {
        if bytes.len() as u64 > MAX_PUBLISH_METADATA_BYTES {
            return Err(corrupt("publication witness exceeds its byte bound"));
        }
        let text = core::str::from_utf8(bytes)
            .map_err(|_| corrupt("publication witness is not UTF-8 JSON"))?;
        if has_duplicate_members(text) {
            return Err(corrupt("publication witness repeats a JSON member"));
        }
        if has_noncanonical_integer_token(bytes) {
            return Err(corrupt(
                "publication witness contains a noncanonical integer",
            ));
        }
        let probe: VersionProbe = serde_json::from_slice(bytes)
            .map_err(|_| corrupt("publication witness is not a JSON object"))?;
        match probe.store_version {
            Some(STORE_METADATA_VERSION) => {}
            Some(found) => return Err(JournalError::SchemaUnsupported { found }),
            None => return Err(corrupt("publication witness is missing storeVersion")),
        }
        let dto: PublishDto = serde_json::from_slice(bytes)
            .map_err(|error| corrupt(format!("invalid publication witness: {error}")))?;
        let maximum = MAX_JOURNAL_ENTRIES as u64 + 1;
        if dto.started_generation == 0
            || dto.started_generation > maximum
            || dto.published_generation > maximum
        {
            return Err(corrupt("publication generation exceeds the store bound"));
        }
        let witness = Self {
            started_generation: dto.started_generation,
            published_generation: dto.published_generation,
        };
        if !(witness.is_clean() || witness.is_initializing() || witness.is_prepared_successor()) {
            return Err(corrupt("publication witness generations are contradictory"));
        }
        Ok(witness)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_relations_round_trip() {
        for witness in [
            PublishWitness::initializing(),
            PublishWitness::clean(1),
            PublishWitness::prepared(2),
        ] {
            assert_eq!(PublishWitness::decode(&witness.encode()).unwrap(), witness);
        }
    }

    #[test]
    fn reverse_gap_and_noncanonical_values_are_rejected() {
        for document in [
            br#"{"storeVersion":2,"startedGeneration":1,"publishedGeneration":2}"#.as_slice(),
            br#"{"storeVersion":2,"startedGeneration":3,"publishedGeneration":1}"#.as_slice(),
            br#"{"storeVersion":2,"startedGeneration":1.0,"publishedGeneration":1}"#.as_slice(),
        ] {
            assert!(matches!(
                PublishWitness::decode(document),
                Err(JournalError::Corrupt { .. })
            ));
        }
    }
}
