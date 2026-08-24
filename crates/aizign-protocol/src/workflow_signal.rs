//! `workflow.signal.submit`: payload DTOs and their conversion to and from
//! the core's workflow types. The DTOs are private; only the conversions
//! and the result type are public.

use aizign_core::workflow::{
    Command, ExpectedAssignment, Role, SignalKind, SignalParts, WorkflowSignal,
};
use aizign_core::{
    ArtifactRef, ArtifactRevision, AssignmentId, AttemptId, Digest, DigestAlgorithm, EventId,
    IdentityError, ShortErrorCode, WorkflowId,
};
use serde::de::{Deserializer, Error as _};
use serde::{Deserialize, Serialize};

use crate::error::{ProtocolError, codes};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SubmitPayload {
    expected: ExpectedDto,
    signal: SignalDto,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExpectedDto {
    workflow_id: String,
    assignment_id: String,
    attempt_id: String,
    role: RoleDto,
    artifact_revision: String,
    candidate_digest: DigestDto,
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

/// Optional fields may be absent but never `null`: absence and `null` would
/// otherwise be two spellings of the same thing, which a closed schema
/// does not allow.
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

impl From<RoleDto> for Role {
    fn from(role: RoleDto) -> Self {
        match role {
            RoleDto::Implementation => Self::Implementation,
            RoleDto::Review => Self::Review,
        }
    }
}

impl From<Role> for RoleDto {
    fn from(role: Role) -> Self {
        match role {
            Role::Implementation => Self::Implementation,
            Role::Review => Self::Review,
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

fn field<T>(code: &str, name: &str, result: Result<T, IdentityError>) -> Result<T, ProtocolError> {
    result.map_err(|error| ProtocolError::new(code, format!("{name}: {error}")))
}

fn digest(code: &str, name: &str, dto: &DigestDto) -> Result<Digest, ProtocolError> {
    field(code, name, Digest::new(dto.algorithm.into(), &dto.hex))
}

/// Decodes a `workflow.signal.submit` payload into a core command.
///
/// Shape problems are `INVALID_PAYLOAD`; well-shaped but invalid
/// expectation values are `INVALID_EXPECTATION`; invalid signal values and
/// kind-specific violations are `INVALID_SIGNAL`.
pub(crate) fn decode_submit(payload: serde_json::Value) -> Result<Command, ProtocolError> {
    let payload: SubmitPayload = serde_json::from_value(payload)
        .map_err(|error| ProtocolError::new(codes::INVALID_PAYLOAD, error.to_string()))?;

    let e = codes::INVALID_EXPECTATION;
    let expected = ExpectedAssignment {
        workflow_id: field(
            e,
            "expected.workflowId",
            WorkflowId::new(&payload.expected.workflow_id),
        )?,
        assignment_id: field(
            e,
            "expected.assignmentId",
            AssignmentId::new(&payload.expected.assignment_id),
        )?,
        attempt_id: field(
            e,
            "expected.attemptId",
            AttemptId::new(&payload.expected.attempt_id),
        )?,
        role: payload.expected.role.into(),
        artifact_revision: field(
            e,
            "expected.artifactRevision",
            ArtifactRevision::new(&payload.expected.artifact_revision),
        )?,
        candidate_digest: digest(
            e,
            "expected.candidateDigest",
            &payload.expected.candidate_digest,
        )?,
    };

    let s = "INVALID_SIGNAL";
    let dto = payload.signal;
    let parts = SignalParts {
        event_id: field(s, "signal.eventId", EventId::new(&dto.event_id))?,
        workflow_id: field(s, "signal.workflowId", WorkflowId::new(&dto.workflow_id))?,
        assignment_id: field(
            s,
            "signal.assignmentId",
            AssignmentId::new(&dto.assignment_id),
        )?,
        attempt_id: field(s, "signal.attemptId", AttemptId::new(&dto.attempt_id))?,
        role: dto.role.into(),
        artifact_revision: field(
            s,
            "signal.artifactRevision",
            ArtifactRevision::new(&dto.artifact_revision),
        )?,
        candidate_digest: digest(s, "signal.candidateDigest", &dto.candidate_digest)?,
        kind: dto.kind.into(),
        finding_count: dto.finding_count,
        artifact_ref: dto
            .artifact_ref
            .as_deref()
            .map(|value| field(s, "signal.artifactRef", ArtifactRef::new(value)))
            .transpose()?,
        short_error_code: dto
            .short_error_code
            .as_deref()
            .map(|value| field(s, "signal.shortErrorCode", ShortErrorCode::new(value)))
            .transpose()?,
    };
    let signal = WorkflowSignal::validate(parts)?;
    Ok(Command::SubmitSignal { signal, expected })
}

/// Encodes a core command as a `workflow.signal.submit` payload.
pub(crate) fn encode_submit(command: &Command) -> serde_json::Value {
    let Command::SubmitSignal { signal, expected } = command;
    let parts = signal.parts();
    let payload = SubmitPayload {
        expected: ExpectedDto {
            workflow_id: expected.workflow_id.to_string(),
            assignment_id: expected.assignment_id.to_string(),
            attempt_id: expected.attempt_id.to_string(),
            role: expected.role.into(),
            artifact_revision: expected.artifact_revision.to_string(),
            candidate_digest: (&expected.candidate_digest).into(),
        },
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
            short_error_code: parts.short_error_code.as_ref().map(ToString::to_string),
        },
    };
    serde_json::to_value(payload).expect("DTOs serialize without error")
}

/// How an accepted submission was classified. Rejections travel as errors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    /// New evidence, durably appended before this response was written.
    Accepted,
    /// Same identity and content as an earlier acceptance; nothing appended.
    Duplicate,
}

/// The `workflow.signal.submit` success payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignalResult {
    /// Classification of the submission.
    pub disposition: Disposition,
    /// The signal's event id, echoed for correlation.
    pub event_id: EventId,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SignalResultDto {
    disposition: Disposition,
    event_id: String,
}

pub(crate) fn decode_result(payload: serde_json::Value) -> Result<SignalResult, ProtocolError> {
    let dto: SignalResultDto = serde_json::from_value(payload)
        .map_err(|error| ProtocolError::new(codes::INVALID_PAYLOAD, error.to_string()))?;
    Ok(SignalResult {
        disposition: dto.disposition,
        event_id: field(
            codes::INVALID_PAYLOAD,
            "eventId",
            EventId::new(&dto.event_id),
        )?,
    })
}

pub(crate) fn encode_result(result: &SignalResult) -> serde_json::Value {
    serde_json::to_value(SignalResultDto {
        disposition: result.disposition,
        event_id: result.event_id.to_string(),
    })
    .expect("DTOs serialize without error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> serde_json::Value {
        json!({
            "expected": {"workflowId": "wf-1", "assignmentId": "as-1", "attemptId": "attempt-1", "role": "implementation", "artifactRevision": "rev-a", "candidateDigest": {"algorithm": "sha256", "hex": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},
            "signal": {"eventId": "evt-1", "workflowId": "wf-1", "assignmentId": "as-1", "attemptId": "attempt-1", "role": "implementation", "artifactRevision": "rev-a", "candidateDigest": {"algorithm": "sha256", "hex": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "kind": "implementation_ready"}
        })
    }

    #[test]
    fn round_trips_a_command() {
        let command = decode_submit(base()).unwrap();
        assert_eq!(encode_submit(&command), base());
    }

    #[test]
    fn unknown_fields_and_null_are_invalid_payload() {
        let mut payload = base();
        payload["signal"]["extra"] = json!(1);
        assert_eq!(
            decode_submit(payload).unwrap_err().code().as_str(),
            codes::INVALID_PAYLOAD
        );

        let mut payload = base();
        payload["signal"]["findingCount"] = json!(null);
        assert_eq!(
            decode_submit(payload).unwrap_err().code().as_str(),
            codes::INVALID_PAYLOAD
        );
    }

    #[test]
    fn value_errors_are_split_between_expectation_and_signal() {
        let mut payload = base();
        payload["expected"]["workflowId"] = json!("bad id");
        assert_eq!(
            decode_submit(payload).unwrap_err().code().as_str(),
            codes::INVALID_EXPECTATION
        );

        let mut payload = base();
        payload["signal"]["eventId"] = json!("");
        assert_eq!(
            decode_submit(payload).unwrap_err().code().as_str(),
            "INVALID_SIGNAL"
        );

        let mut payload = base();
        payload["signal"]["kind"] = json!("review_passed");
        let error = decode_submit(payload).unwrap_err();
        assert_eq!(error.code().as_str(), "INVALID_SIGNAL");
        assert!(
            error.message().contains("requires the Review role"),
            "{error}"
        );
    }

    #[test]
    fn result_round_trip() {
        let result = SignalResult {
            disposition: Disposition::Duplicate,
            event_id: EventId::new("evt-1").unwrap(),
        };
        let encoded = encode_result(&result);
        assert_eq!(
            encoded,
            json!({"disposition": "duplicate", "eventId": "evt-1"})
        );
        assert_eq!(decode_result(encoded).unwrap(), result);
    }
}
