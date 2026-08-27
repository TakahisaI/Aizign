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
  type CorrelationMismatch,
  checkCorrelation,
  type HelloOutcome,
  type ReconcileOutcome,
  type ReconcileUnknown,
  type SentRequest,
  type SubmitOutcome,
  type UnknownOutcome,
} from './client.ts';
export {
  type BoundedFrameExtraction,
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
  OneShotFrameCollector,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type Request,
  type Response,
  type ResponseBody,
} from './envelope.ts';
export { codes, isShortErrorCode, ProtocolError } from './error.ts';
export {
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  checkCompatibility,
  type HelloInfo,
  type Incompatibility,
  type PackageInfo,
} from './hello.ts';
export { isIdentifier } from './shape.ts';
export {
  type ContentDigest,
  type Disposition,
  decodeWorkflowSignalReconcile,
  decodeWorkflowSignalSubmit,
  type ExpectedAssignment,
  encodeWorkflowSignalReconcile,
  encodeWorkflowSignalSubmit,
  type ReconciliationDisposition,
  type ReconciliationResult,
  type Role,
  type SignalKind,
  type SignalResult,
  type WorkflowSignal,
  type WorkflowSignalReconcilePayload,
  type WorkflowSignalSubmitPayload,
} from './workflow-signal.ts';
