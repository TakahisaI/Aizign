//! Journal record v1: the closed, metadata-only line format.

use aizu_core::workflow::{Role, SignalKind, SignalParts, WorkflowEvent, WorkflowSignal};
use aizu_core::{
    ArtifactRef, ArtifactRevision, AssignmentId, BoundedTimestamp, EventId, ShortErrorCode,
    WorkflowId,
};
use aizu_engine::{JournalEntry, JournalError};
use serde::de::{Deserializer, Error as _};
use serde::{Deserialize, Serialize};

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
    role: RoleDto,
    artifact_revision: String,
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
pub(crate) fn encode_entry(entry: &JournalEntry) -> String {
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
            role: parts.role.into(),
            artifact_revision: parts.artifact_revision.to_string(),
            kind: parts.kind.into(),
            finding_count: parts.finding_count,
            artifact_ref: parts.artifact_ref.as_ref().map(ToString::to_string),
            short_error_code: parts.short_error_code.as_ref().map(ToString::to_string),
        },
    };
    serde_json::to_string(&record).expect("records serialize without error")
}

/// Decodes one line. Shape, version, and value problems are all reported
/// without echoing the line's contents.
pub(crate) fn decode_line(line_number: usize, line: &str) -> Result<JournalEntry, JournalError> {
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

    let dto = record.signal;
    let parts = SignalParts {
        event_id: field(line_number, "eventId", EventId::new(&dto.event_id))?,
        workflow_id: field(line_number, "workflowId", WorkflowId::new(&dto.workflow_id))?,
        assignment_id: field(
            line_number,
            "assignmentId",
            AssignmentId::new(&dto.assignment_id),
        )?,
        role: dto.role.into(),
        artifact_revision: field(
            line_number,
            "artifactRevision",
            ArtifactRevision::new(&dto.artifact_revision),
        )?,
        kind: dto.kind.into(),
        finding_count: dto.finding_count,
        artifact_ref: dto
            .artifact_ref
            .as_deref()
            .map(|value| field(line_number, "artifactRef", ArtifactRef::new(value)))
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
    result: Result<T, aizu_core::IdentityError>,
) -> Result<T, JournalError> {
    result.map_err(|error| corrupt(format!("line {line_number}: signal.{name}: {error}")))
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
            role: Role::Review,
            artifact_revision: ArtifactRevision::new("rev-a").unwrap(),
            kind: SignalKind::ReviewFindings,
            finding_count: Some(2),
            artifact_ref: Some(ArtifactRef::new("review:abc").unwrap()),
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
        let line = encode_entry(&entry());
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
        let base: serde_json::Value = serde_json::from_str(&encode_entry(&entry())).unwrap();
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
        let base: serde_json::Value = serde_json::from_str(&encode_entry(&entry())).unwrap();

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
