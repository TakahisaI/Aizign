/**
 * `@aizign/adapter-dsh` — the DSH plugin. Registers one scope-bound
 * `submit_workflow_signal` tool backed by the `aizign` binary over Protocol v1.
 *
 * The plugin knows DSH; the core never does. DSH session ids, call ids, and
 * agent handles stay on this side of the process boundary.
 */

import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { type AdapterConfig, Config, ConfigError, validateConfig } from './config.ts';
import { OneShotCoreClient } from './core-client/one-shot-client.ts';
import { preflight } from './lifecycle/preflight.ts';
import { adapterCodes, createSubmitWorkflowSignalTool, TOOL_NAME } from './mapping/tool.ts';

export const name = 'aizign-workflow-signal';
export const inject = ['tools'];
export type { AdapterConfig, Config as PluginConfig, SignalBinding } from './config.ts';
export { OneShotCoreClient } from './core-client/one-shot-client.ts';
export {
  type ColdReadOptions,
  DEFAULT_COLD_READ_TIMEOUT_MS,
  DEFAULT_MAX_EVENTS,
  type EvidenceSource,
  readSignalEvidence,
  type SessionEventLike,
  type SignalEvidence,
  type SignalResultMeta,
} from './evidence/cold-read.ts';
export { bindingDigest, canonicalJson, payloadDigest } from './evidence/digest.ts';
export { preflight, RECONCILIATION_REQUIRED, REQUIRED } from './lifecycle/preflight.ts';
export {
  adapterCodes,
  createSubmitWorkflowSignalTool,
  decodeArgs,
  kindsForRole,
  newRequestId,
  presentationMetaFor,
  type SignalArgs,
  TOOL_NAME,
  toolParameters,
  toPayload,
  toToolResult,
} from './mapping/tool.ts';
export { Config };

/** Builds the client for a validated configuration. */
export function createClient(config: AdapterConfig): OneShotCoreClient {
  return new OneShotCoreClient({
    command: config.binary,
    stateDir: config.stateDir,
    timeoutMs: config.timeoutMs,
  });
}

/** cordis plugin entry point. */
export async function apply(ctx: Context, raw: Config): Promise<void> {
  let config: AdapterConfig;
  try {
    config = validateConfig(raw);
  } catch (error) {
    if (error instanceof ConfigError)
      throw new HarnessError(error.message, 'INVALID_EXPECTATION', { cause: error });
    throw error;
  }
  const client = createClient(config);
  await preflight(client);
  ctx.tools.register(createSubmitWorkflowSignalTool(client, config.binding));
}

export const registeredTools: readonly string[] = [TOOL_NAME];
export { adapterCodes as codes };
