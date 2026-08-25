/**
 * `@aizign/protocol` — Aizign Protocol v1 for TypeScript.
 *
 * Closed NDJSON envelope codec, the `hello` compatibility check, the
 * workflow signal submit/reconciliation payload types, and a TypeScript
 * reference `CoreClient` interface. Pure: no process, no filesystem.
 */

export {
  type CallOptions,
  type CoreClient,
  type CoreClientConfig,
  type CorrelationMismatch,
  checkCorrelation,
  emitBestEffort,
  type HelloOutcome,
  isSubmitRejectionCode,
  isTimingErrorCode,
  isUnknownOutcomeCode,
  type ParentOperationKind,
  type ParentTimingMeasurement,
  type ParentTimingSink,
  parentTimingOutcome,
  type ReconcileOutcome,
  type ReconcileUnknown,
  type SentRequest,
  SUBMIT_REJECTION_CODES,
  type SubmitOutcome,
  TIMING_ERROR_CODES,
  type TimingOutcome,
  type TimingSink,
  UNKNOWN_OUTCOME_CODES,
  type UnknownOutcome,
} from './client.ts';
export {
  DecodeFailure,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  extractFrame,
  type FrameExtraction,
  KIND_HELLO,
  KIND_WORKFLOW_SIGNAL_RECONCILE,
  KIND_WORKFLOW_SIGNAL_SUBMIT,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BYTES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type Request,
  type Response,
  type ResponseBody,
} from './envelope.ts';
export { codes, isShortErrorCode, ProtocolError, SHORT_ERROR_CODE_PATTERN } from './error.ts';
export {
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  checkCompatibility,
  decodeHelloInfo,
  type HelloInfo,
  type Incompatibility,
  type PackageInfo,
} from './hello.ts';
export { IDENTIFIER_PATTERN, isIdentifier } from './shape.ts';
export {
  type ContentDigest,
  type Disposition,
  decodeReconciliationResult,
  decodeSignalResult,
  decodeWorkflowSignalReconcile,
  decodeWorkflowSignalSubmit,
  type ExpectedAssignment,
  encodeWorkflowSignal,
  encodeWorkflowSignalReconcile,
  encodeWorkflowSignalSubmit,
  type ReconciliationDisposition,
  type ReconciliationResult,
  ROLES,
  type Role,
  SIGNAL_KINDS,
  type SignalKind,
  type SignalResult,
  type WorkflowSignal,
  type WorkflowSignalReconcilePayload,
  type WorkflowSignalSubmitPayload,
} from './workflow-signal.ts';
