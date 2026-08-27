/**
 * `@aizign/adapter-testkit` — fixtures, assertions, and scenario runners for
 * exercising a supplied production `CoreClient` against a fake core.
 */

export {
  assertMetadataOnly,
  type ConformanceOptions,
  type CoreClientFactory,
  type CoreClientFixtureConfig,
  type CoreCommand,
  readFakeRequests,
  runCoreClientConformance,
  runCoreScenarios,
  samplePayload,
} from './conformance.ts';
export { fakeCoreExecutable } from './fake-core-path.ts';
