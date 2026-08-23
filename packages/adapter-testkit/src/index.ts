/**
 * `@aizu/adapter-testkit` — prove a harness adapter's core client against a
 * fake core, including every way an outcome can be unknown.
 */

export {
  assertMetadataOnly,
  type ConformanceOptions,
  type CoreClientFactory,
  FORBIDDEN_KEYS,
  runCoreClientConformance,
  samplePayload,
} from './conformance.ts';
export { fakeCoreCommand } from './fake-core-path.ts';
export { ReferenceOneShotClient } from './reference-client.ts';
