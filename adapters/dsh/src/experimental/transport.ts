/** Closed provisional access to DSH-owned process transport and parent timing. */

export { OneShotCoreClient, type OneShotCoreClientConfig } from '../core-client/one-shot-client.ts';
export { type PreflightOptions, preflight } from '../lifecycle/preflight.ts';
export {
  isTimingErrorCode,
  type ParentOperationKind,
  type ParentTimingMeasurement,
  type ParentTimingSink,
  type TimingOutcome,
  type TimingSink,
} from '../timing.ts';
