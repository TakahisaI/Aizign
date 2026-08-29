/** A minimal stand-in for DSH tool registration and dispatch. */

import { fakeCoreExecutable } from '@aizign/adapter-testkit';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

export interface DispatchResult {
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly code: string };
}

export class FakeDsh {
  readonly registered: ToolDefinition[] = [];
  readonly context: Context;
  #calls = 0;

  constructor() {
    this.context = {
      tools: {
        register: (definition: ToolDefinition) => {
          this.registered.push(definition);
          return () => undefined;
        },
      },
    } as unknown as Context;
  }

  tool(name: string): ToolDefinition {
    const tool = this.registered.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`tool ${name} is not registered`);
    return tool;
  }

  /** Dispatches a registered tool with a harness-owned call id. */
  async dispatch(name: string, args: unknown): Promise<DispatchResult> {
    const tool = this.tool(name);
    const callId = `call_${String(++this.#calls).padStart(4, '0')}`;
    const exec = { callId, signal: new AbortController().signal } as unknown as ToolRunContext;
    try {
      const value = await tool.execute(args, exec);
      return { value };
    } catch (error) {
      const named = error as { name?: string; code?: string };
      return { error: { name: named.name ?? 'Error', code: named.code ?? 'UNKNOWN_ERROR' } };
    }
  }
}

/** An executable that runs the fake core, so a plain `binary` path reaches it. */
export function fakeBinary(
  dir: string,
  controls: Parameters<typeof fakeCoreExecutable>[1] = {},
): string {
  return fakeCoreExecutable(dir, controls);
}
