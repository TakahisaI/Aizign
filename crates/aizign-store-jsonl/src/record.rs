//! Journal record v1: the closed, metadata-only line format.

use aizign_core::workflow::{Role, SignalKind, SignalParts, WorkflowEvent, WorkflowSignal};
use aizign_core::{
    ArtifactRef, ArtifactRevision, AssignmentId, AttemptId, BoundedTimestamp, Digest,
    DigestAlgorithm, EventId, ShortErrorCode, WorkflowId,
};
use aizign_engine::{JournalEntry, JournalError, MAX_JOURNAL_ENTRIES};
use serde::de::{Deserializer, Error as _};
use serde::{Deserialize, Serialize};

use crate::json_member::has_duplicate_members;

/// The journal schema version this crate reads and writes.
pub const JOURNAL_SCHEMA_VERSION: u64 = 1;

const KIND_SIGNAL_ACCEPTED: &str = "workflow.signal.accepted";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RecordDto {
    schema_version: u64,
    seq: u64,
    at: u64,
    kind: String,
    signal: SignalDto,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SignalDto {
    event_id: String,
    workflow_id: String,
    assignment_id: String,
    attempt_id: String,
    role: RoleDto,
    artifact_revision: String,
    candidate_digest: DigestDto,
    kind: KindDto,
    #[serde(
        default,
        deserialize_with = "reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    finding_count: Option<u32>,
    #[serde(
        default,
        deserialize_with = "reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    artifact_ref: Option<String>,
    #[serde(
        default,
        deserialize_with = "reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    evidence_digest: Option<DigestDto>,
    #[serde(
        default,
        deserialize_with = "reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    source_event_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    short_error_code: Option<String>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RoleDto {
    Implementation,
    Review,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum KindDto {
    ImplementationReady,
    ReviewFindings,
    ReviewPassed,
    RepairSubmitted,
    Blocked,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DigestDto {
    algorithm: DigestAlgorithmDto,
    hex: String,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DigestAlgorithmDto {
    Sha256,
}

impl From<DigestAlgorithmDto> for DigestAlgorithm {
    fn from(algorithm: DigestAlgorithmDto) -> Self {
        match algorithm {
            DigestAlgorithmDto::Sha256 => Self::Sha256,
        }
    }
}

impl From<DigestAlgorithm> for DigestAlgorithmDto {
    fn from(algorithm: DigestAlgorithm) -> Self {
        match algorithm {
            DigestAlgorithm::Sha256 => Self::Sha256,
        }
    }
}

impl From<&Digest> for DigestDto {
    fn from(digest: &Digest) -> Self {
        Self {
            algorithm: digest.algorithm().into(),
            hex: digest.hex().to_owned(),
        }
    }
}

fn reject_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(D::Error::custom(
            "null is not allowed; omit the field instead",
        ));
    }
    T::deserialize(value).map(Some).map_err(D::Error::custom)
}

impl From<Role> for RoleDto {
    fn from(role: Role) -> Self {
        match role {
            Role::Implementation => Self::Implementation,
            Role::Review => Self::Review,
        }
    }
}

impl From<RoleDto> for Role {
    fn from(role: RoleDto) -> Self {
        match role {
            RoleDto::Implementation => Self::Implementation,
            RoleDto::Review => Self::Review,
        }
    }
}

impl From<SignalKind> for KindDto {
    fn from(kind: SignalKind) -> Self {
        match kind {
            SignalKind::ImplementationReady => Self::ImplementationReady,
            SignalKind::ReviewFindings => Self::ReviewFindings,
            SignalKind::ReviewPassed => Self::ReviewPassed,
            SignalKind::RepairSubmitted => Self::RepairSubmitted,
            SignalKind::Blocked => Self::Blocked,
        }
    }
}

impl From<KindDto> for SignalKind {
    fn from(kind: KindDto) -> Self {
        match kind {
            KindDto::ImplementationReady => Self::ImplementationReady,
            KindDto::ReviewFindings => Self::ReviewFindings,
            KindDto::ReviewPassed => Self::ReviewPassed,
            KindDto::RepairSubmitted => Self::RepairSubmitted,
            KindDto::Blocked => Self::Blocked,
        }
    }
}

fn corrupt(detail: impl Into<String>) -> JournalError {
    JournalError::Corrupt {
        detail: detail.into(),
    }
}

/// Encodes one entry as a single line without the trailing newline.
///
/// Fails with [`JournalError::Corrupt`] when `entry.seq` is outside the
/// durable record range `1..=[MAX_JOURNAL_ENTRIES]`: the encoder must not
/// be able to produce a line the decoder (and the JSON Schema) rejects,
/// so a successful append can never be unreadable by the next cold read.
pub(crate) fn encode_entry(entry: &JournalEntry) -> Result<String, JournalError> {
    if entry.seq == 0 || entry.seq > MAX_JOURNAL_ENTRIES as u64 {
        return Err(corrupt(format!(
            "entry seq {} is outside the record range 1..={MAX_JOURNAL_ENTRIES}",
            entry.seq
        )));
    }
    let WorkflowEvent::SignalAccepted { signal } = &entry.event;
    let parts = signal.parts();
    let record = RecordDto {
        schema_version: JOURNAL_SCHEMA_VERSION,
        seq: entry.seq,
        at: entry.at.unix_seconds(),
        kind: KIND_SIGNAL_ACCEPTED.to_owned(),
        signal: SignalDto {
            event_id: parts.event_id.to_string(),
            workflow_id: parts.workflow_id.to_string(),
            assignment_id: parts.assignment_id.to_string(),
            attempt_id: parts.attempt_id.to_string(),
            role: parts.role.into(),
            artifact_revision: parts.artifact_revision.to_string(),
            candidate_digest: (&parts.candidate_digest).into(),
            kind: parts.kind.into(),
            finding_count: parts.finding_count,
            artifact_ref: parts.artifact_ref.as_ref().map(ToString::to_string),
            evidence_digest: parts.evidence_digest.as_ref().map(Into::into),
            source_event_id: parts.source_event_id.as_ref().map(ToString::to_string),
            short_error_code: parts.short_error_code.as_ref().map(ToString::to_string),
        },
    };
    Ok(serde_json::to_string(&record).expect("records serialize without error"))
}

/// Encodes one entry as its canonical record line, without the newline —
/// the counterpart of [`decode_record`] for the conformance fixtures.
///
/// Like [`decode_record`], it accepts exactly the set the published schema
/// accepts: an out-of-range `seq` is [`JournalError::Corrupt`], mirrored
/// after the decoder's record-level rule.
pub fn encode_record(entry: &JournalEntry) -> Result<String, JournalError> {
    encode_entry(entry)
}

/// Decodes one record line by the grammar of `spec/journal/v1` — the entry
/// point the conformance fixtures exercise. Journal-level rules (contiguous
/// `seq`, the entry bound of a whole file) live in [`crate::JsonlJournal`].
pub fn decode_record(line: &str) -> Result<JournalEntry, JournalError> {
    decode_line(1, line)
}

/// Decodes one line. Shape, version, and value problems are all reported
/// without echoing the line's contents.
pub(crate) fn decode_line(line_number: usize, line: &str) -> Result<JournalEntry, JournalError> {
    if has_duplicate_members(line) {
        return Err(corrupt(format!(
            "line {line_number}: record repeats a JSON member"
        )));
    }
    let version_probe: VersionProbe = serde_json::from_str(line)
        .map_err(|_| corrupt(format!("line {line_number}: not a JSON object")))?;
    match version_probe.schema_version {
        Some(JOURNAL_SCHEMA_VERSION) => {}
        Some(found) => return Err(JournalError::SchemaUnsupported { found }),
        None => {
            return Err(corrupt(format!(
                "line {line_number}: missing schemaVersion"
            )));
        }
    }

    let record: RecordDto = serde_json::from_str(line)
        .map_err(|error| corrupt(format!("line {line_number}: {error}")))?;
    if record.kind != KIND_SIGNAL_ACCEPTED {
        return Err(corrupt(format!("line {line_number}: unknown record kind")));
    }
    let at = BoundedTimestamp::from_unix_seconds(record.at)
        .map_err(|error| corrupt(format!("line {line_number}: at: {error}")))?;
    if record.seq == 0 || record.seq > MAX_JOURNAL_ENTRIES as u64 {
        return Err(corrupt(format!(
            "line {line_number}: seq must be 1..={MAX_JOURNAL_ENTRIES}"
        )));
    }

    let dto = record.signal;
    let parts = SignalParts {
        event_id: field(line_number, "eventId", EventId::new(&dto.event_id))?,
        workflow_id: field(line_number, "workflowId", WorkflowId::new(&dto.workflow_id))?,
        assignment_id: field(
            line_number,
            "assignmentId",
            AssignmentId::new(&dto.assignment_id),
        )?,
        attempt_id: field(line_number, "attemptId", AttemptId::new(&dto.attempt_id))?,
        role: dto.role.into(),
        artifact_revision: field(
            line_number,
            "artifactRevision",
            ArtifactRevision::new(&dto.artifact_revision),
        )?,
        candidate_digest: digest(line_number, "candidateDigest", &dto.candidate_digest)?,
        kind: dto.kind.into(),
        finding_count: dto.finding_count,
        artifact_ref: dto
            .artifact_ref
            .as_deref()
            .map(|value| field(line_number, "artifactRef", ArtifactRef::new(value)))
            .transpose()?,
        evidence_digest: dto
            .evidence_digest
            .map(|value| digest(line_number, "evidenceDigest", &value))
            .transpose()?,
        source_event_id: dto
            .source_event_id
            .as_deref()
            .map(|value| field(line_number, "sourceEventId", EventId::new(value)))
            .transpose()?,
        short_error_code: dto
            .short_error_code
            .as_deref()
            .map(|value| field(line_number, "shortErrorCode", ShortErrorCode::new(value)))
            .transpose()?,
    };
    let signal = WorkflowSignal::validate(parts)
        .map_err(|error| corrupt(format!("line {line_number}: signal: {error}")))?;

    Ok(JournalEntry {
        seq: record.seq,
        at,
        event: WorkflowEvent::SignalAccepted { signal },
    })
}

fn field<T>(
    line_number: usize,
    name: &str,
    result: Result<T, aizign_core::IdentityError>,
) -> Result<T, JournalError> {
    result.map_err(|error| corrupt(format!("line {line_number}: signal.{name}: {error}")))
}

fn digest(line_number: usize, name: &str, dto: &DigestDto) -> Result<Digest, JournalError> {
    field(
        line_number,
        name,
        Digest::new(dto.algorithm.into(), &dto.hex),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionProbe {
    #[serde(default)]
    schema_version: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> JournalEntry {
        let signal = WorkflowSignal::validate(SignalParts {
            event_id: EventId::new("evt-1").unwrap(),
            workflow_id: WorkflowId::new("wf-1").unwrap(),
            assignment_id: AssignmentId::new("as-1").unwrap(),
            attempt_id: AttemptId::new("attempt-1").unwrap(),
            role: Role::Review,
            artifact_revision: ArtifactRevision::new("rev-a").unwrap(),
            candidate_digest: Digest::new(DigestAlgorithm::Sha256, &"a".repeat(64)).unwrap(),
            kind: SignalKind::ReviewFindings,
            finding_count: Some(2),
            artifact_ref: Some(ArtifactRef::new("review:abc").unwrap()),
            evidence_digest: Some(Digest::new(DigestAlgorithm::Sha256, &"b".repeat(64)).unwrap()),
            source_event_id: None,
            short_error_code: None,
        })
        .unwrap();
        JournalEntry {
            seq: 7,
            at: BoundedTimestamp::from_unix_seconds(1_724_400_000).unwrap(),
            event: WorkflowEvent::SignalAccepted { signal },
        }
    }

    #[test]
    fn round_trips_and_stays_on_one_line() {
        let line = encode_entry(&entry()).unwrap();
        assert!(!line.contains('\n'));
        assert_eq!(decode_line(1, &line).unwrap(), entry());
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["schemaVersion"], JOURNAL_SCHEMA_VERSION);
        assert_eq!(value["kind"], KIND_SIGNAL_ACCEPTED);
        assert_eq!(value["signal"]["findingCount"], 2);
        assert!(
            value["signal"].get("shortErrorCode").is_none(),
            "absent, not null"
        );
    }

    #[test]
    fn unsupported_versions_are_reported_before_shape_errors() {
        assert_eq!(
            decode_line(3, r#"{"schemaVersion":2,"anything":true}"#),
            Err(JournalError::SchemaUnsupported { found: 2 })
        );
    }

    #[test]
    fn forbidden_and_unknown_fields_are_corrupt() {
        let base: serde_json::Value =
            serde_json::from_str(&encode_entry(&entry()).unwrap()).unwrap();
        for forbidden in [
            "prompt",
            "output",
            "reasoning",
            "token",
            "sessionId",
            "threadId",
        ] {
            let mut record = base.clone();
            record[forbidden] = serde_json::Value::String("x".to_owned());
            let result = decode_line(1, &record.to_string());
            assert!(
                matches!(result, Err(JournalError::Corrupt { .. })),
                "{forbidden}: {result:?}"
            );

            let mut record = base.clone();
            record["signal"][forbidden] = serde_json::Value::String("x".to_owned());
            let result = decode_line(1, &record.to_string());
            assert!(
                matches!(result, Err(JournalError::Corrupt { .. })),
                "signal.{forbidden}: {result:?}"
            );
        }
    }

    #[test]
    fn invalid_values_and_kinds_are_corrupt_without_echoing_contents() {
        let base: serde_json::Value =
            serde_json::from_str(&encode_entry(&entry()).unwrap()).unwrap();

        let mut record = base.clone();
        record["signal"]["role"] = serde_json::Value::String("implementation".to_owned());
        let Err(JournalError::Corrupt { detail }) = decode_line(1, &record.to_string()) else {
            panic!("role/kind mismatch must be corrupt");
        };
        assert!(detail.starts_with("line 1: signal:"), "{detail}");

        let mut record = base.clone();
        record["kind"] = serde_json::Value::String("workflow.other".to_owned());
        assert!(matches!(
            decode_line(1, &record.to_string()),
            Err(JournalError::Corrupt { .. })
        ));

        let mut record = base;
        record["signal"]["eventId"] = serde_json::Value::String("secret value here".to_owned());
        let Err(JournalError::Corrupt { detail }) = decode_line(1, &record.to_string()) else {
            panic!("invalid identifier must be corrupt");
        };
        assert!(
            !detail.contains("secret"),
            "details never echo record contents: {detail}"
        );
    }
}
