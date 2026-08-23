import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeCoreCommand } from '@aizu/adapter-testkit';
import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { OneShotCoreClient } from '../../src/core-client/one-shot-client.ts';
import {
  apply,
  type Config,
  Config as ConfigSchema,
  codes,
  inject,
  name,
} from '../../src/index.ts';
import { preflight } from '../../src/lifecycle/preflight.ts';
import { fakeBinary } from '../helpers/fake-dsh.ts';

/** A fake that wraps the fake core script so `binary` alone is enough. */
function fakeBinaryConfig(
  stateDir: string,
  env: Record<string, string> = {},
): Config & { env: Record<string, string> } {
  return {
    binary: fakeCoreCommand().command,
    stateDir,
    eventId: 'evt-1',
    workflowId: 'wf-1',
    assignmentId: 'as-impl',
    role: 'implementation',
    artifactRevision: 'rev-a',
    env,
  };
}

function fakeContext(): Context & { registered: ToolDefinition[] } {
  const registered: ToolDefinition[] = [];
  return {
    registered,
    tools: {
      register(definition: ToolDefinition) {
        registered.push(definition);
        return () => undefined;
      },
    },
  } as unknown as Context & { registered: ToolDefinition[] };
}

test('plugin shape: name, inject, and a schemastery Config', () => {
  assert.equal(name, 'aizu-workflow-signal');
  assert.deepEqual(inject, ['tools']);
  const parsed = ConfigSchema({
    binary: '/x/aizu',
    stateDir: '/x/state',
    eventId: 'evt-1',
    workflowId: 'wf-1',
    assignmentId: 'as-impl',
    role: 'review',
    artifactRevision: 'rev-a',
  });
  assert.equal(parsed.timeoutMs, 15_000);
  assert.throws(() => ConfigSchema({ binary: '/x/aizu' } as Config));
});

test('preflight accepts a compatible core and rejects an incompatible or unreachable one', async () => {
  const fake = fakeCoreCommand();
  const ok = new OneShotCoreClient({ ...fake, stateDir: '/unused', timeoutMs: 5_000 });
  const info = await preflight(ok);
  assert.equal(info.protocolVersion, 1);

  const future = new OneShotCoreClient({
    ...fake,
    env: { AIZU_FAKE_HELLO_PROTOCOL_VERSION: '2' },
    stateDir: '/unused',
    timeoutMs: 5_000,
  });
  await assert.rejects(preflight(future), (error: unknown) => {
    return error instanceof HarnessError && error.code === codes.INCOMPATIBLE;
  });

  const silent = new OneShotCoreClient({
    ...fake,
    env: { AIZU_FAKE_FAULT: 'no-response' },
    stateDir: '/unused',
    timeoutMs: 5_000,
  });
  await assert.rejects(preflight(silent), (error: unknown) => {
    return error instanceof HarnessError && error.code === codes.UNAVAILABLE;
  });
});

test('apply runs the preflight and registers exactly one scope-bound tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizu-dsh-plugin-'));
  try {
    const ctx = fakeContext();
    const config = fakeBinaryConfig(join(root, 'state'));
    await apply(ctx, { ...config, binary: fakeBinary(root) });
    assert.equal(ctx.registered.length, 1);
    const tool = ctx.registered[0];
    assert.equal(tool?.name, 'submit_workflow_signal');

    // The registered tool reaches the (fake) core: accepted, then duplicate.
    const exec = {
      callId: 'call-1',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext;
    assert.deepEqual(await tool?.execute({ kind: 'implementation_ready' }, exec), {
      disposition: 'accepted',
      eventId: 'evt-1',
    });
    assert.deepEqual(await tool?.execute({ kind: 'implementation_ready' }, exec), {
      disposition: 'duplicate',
      eventId: 'evt-1',
    });

    // Incompatible core: nothing is registered.
    const incompatible = fakeContext();
    await assert.rejects(
      apply(incompatible, {
        ...config,
        binary: fakeBinary(join(root, 'v2'), { AIZU_FAKE_HELLO_PROTOCOL_VERSION: '2' }),
      }),
      (error: unknown) => error instanceof HarnessError && error.code === codes.INCOMPATIBLE,
    );
    assert.equal(incompatible.registered.length, 0);

    // Not an aizu at all: fails closed as unavailable.
    const broken = fakeContext();
    await assert.rejects(
      apply(broken, { ...config, binary: process.execPath }),
      (error: unknown) => error instanceof HarnessError && error.code === codes.UNAVAILABLE,
    );
    assert.equal(broken.registered.length, 0, 'no tool is offered when the preflight fails');

    // Invalid identity in the configuration never reaches the binary.
    await assert.rejects(
      apply(fakeContext(), { ...config, binary: fakeBinary(root), eventId: 'bad id' }),
      (error: unknown) => error instanceof HarnessError && error.code === 'INVALID_EXPECTATION',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
