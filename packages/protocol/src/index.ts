/**
 * `@aizu/protocol` — Aizu Protocol v1 for TypeScript.
 *
 * Closed NDJSON envelope codec, the `hello` compatibility check, the
 * `workflow.signal.submit` payload types, and the `CoreClient` contract that
 * every harness adapter implements. Pure: no process, no filesystem.
 */

export {
  type CoreClient,
  type CoreClientConfig,
  type HelloOutcome,
  isUnknownOutcomeCode,
  type SubmitOutcome,
  UNKNOWN_OUTCOME_CODES,
  type UnknownOutcome,
} from './client.ts';
export {
  DecodeFailure,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  KIND_HELLO,
  KIND_WORKFLOW_SIGNAL_SUBMIT,
  MAX_REQUEST_BYTES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type Request,
  type Response,
  type ResponseBody,
} from './envelope.ts';
export { codes, isShortErrorCode, ProtocolError, SHORT_ERROR_CODE_PATTERN } from './error.ts';
export {
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  checkCompatibility,
  decodeHelloInfo,
  type HelloInfo,
  type Incompatibility,
  type PackageInfo,
} from './hello.ts';
export { IDENTIFIER_PATTERN, isIdentifier } from './shape.ts';
export {
  type Disposition,
  decodeSignalResult,
  decodeWorkflowSignalSubmit,
  type ExpectedAssignment,
  encodeWorkflowSignalSubmit,
  ROLES,
  type Role,
  SIGNAL_KINDS,
  type SignalKind,
  type SignalResult,
  type WorkflowSignal,
  type WorkflowSignalSubmitPayload,
} from './workflow-signal.ts';
