/** Closed provisional access to DSH-owned harness evidence; removed by Issue #80. */

export type { SignalBinding } from '../config.ts';
export {
  type ColdReadOptions,
  type ColdReadTimingMeasurement,
  type ColdReadTimingSink,
  type ColdReadUnknownReason,
  DEFAULT_COLD_READ_TIMEOUT_MS,
  DEFAULT_MAX_EVENTS,
  type EvidenceSource,
  readSignalEvidence,
  type SessionEventLike,
  type SignalEvidence,
  type SignalResultMeta,
} from '../evidence/cold-read.ts';
export { presentationMetaFor, type SignalPresentationMeta } from '../mapping/tool.ts';
