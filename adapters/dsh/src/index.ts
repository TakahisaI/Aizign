/**
 * `@aizign/adapter-dsh` — the DSH plugin. Registers one scope-bound
 * `submit_workflow_signal` tool backed by the `aizign` binary over Protocol v1.
 *
 * The plugin knows DSH; the core never does. DSH session ids, call ids, and
 * agent handles stay on this side of the process boundary.
 */

import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import {
  type AdapterConfig,
  ConfigError,
  type Config as PluginConfig,
  Config as PluginConfigSchema,
  validateConfig,
} from './config.ts';
import { OneShotCoreClient } from './core-client/one-shot-client.ts';
import { preflight } from './lifecycle/preflight.ts';
import { createSubmitWorkflowSignalTool } from './mapping/tool.ts';

export const name = 'aizign-workflow-signal';
export const inject = ['tools'];
export type { Config as PluginConfig } from './config.ts';
export const Config = PluginConfigSchema;

/** Builds the client for a validated configuration. */
function createClient(config: AdapterConfig): OneShotCoreClient {
  return new OneShotCoreClient({
    command: config.binary,
    stateDir: config.stateDir,
    timeoutMs: config.timeoutMs,
  });
}

/** cordis plugin entry point. */
export async function apply(ctx: Context, raw: PluginConfig): Promise<void> {
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
