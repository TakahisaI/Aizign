/**
 * A minimal stand-in for the DSH tool runtime: registers tools, dispatches
 * calls the way DSH does (tool/call, execute, tool/result with presentation
 * metadata or an error), and keeps the resulting session log in memory so
 * the cold read can be exercised without a harness.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCoreExecutable } from '@aizign/adapter-testkit';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { EvidenceSource, SessionEventLike } from '../../src/evidence/cold-read.ts';

export interface DispatchResult {
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly code: string };
}

export class FakeDsh implements EvidenceSource {
  readonly sessionId = 'dsh-session-0001';
  readonly registered: ToolDefinition[] = [];
  readonly events: SessionEventLike[] = [];
  readonly context: Context;
  #seq = 0;
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

  /** Dispatches like DSH while recording an in-memory call/result pair. */
  async dispatch(name: string, args: unknown): Promise<DispatchResult> {
    const tool = this.tool(name);
    const callId = `call_${String(++this.#calls).padStart(4, '0')}`;
    this.events.push({
      type: 'tool/call',
      seq: ++this.#seq,
      data: { turn: 1, step: this.#calls, callId, name, arguments: JSON.stringify(args) },
    });
    const exec = { callId, signal: new AbortController().signal } as unknown as ToolRunContext;
    let outcome: DispatchResult;
    let meta: unknown;
    try {
      const value = await tool.execute(args, exec);
      meta = tool.output.presentationMeta?.(args, value as never);
      outcome = { value };
    } catch (error) {
      const named = error as { name?: string; code?: string };
      outcome = { error: { name: named.name ?? 'Error', code: named.code ?? 'UNKNOWN_ERROR' } };
    }
    this.events.push({
      type: 'tool/result',
      seq: ++this.#seq,
      data: {
        turn: 1,
        step: this.#calls,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              content: [],
              isError: outcome.error !== undefined,
            },
          ],
          source: { kind: 'tool', callId },
        },
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(meta !== undefined ? { meta } : {}),
      },
    });
    return outcome;
  }

  async readFrom(
    _sessionId: string,
    fromSeq: number,
  ): Promise<{ events: readonly SessionEventLike[] }> {
    return { events: this.events.filter((event) => event.seq >= fromSeq) };
  }
}

/** An executable that runs the fake core, so a plain `binary` path reaches it. */
export function fakeBinary(dir: string, env: Record<string, string> = {}): string {
  const fake = fakeCoreExecutable(join(dir, 'core'));
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'aizign-fake');
  writeFileSync(path, `#!/bin/sh\n${exports}\nexec ${JSON.stringify(fake)} "$@"\n`, {
    mode: 0o755,
  });
  return path;
}
