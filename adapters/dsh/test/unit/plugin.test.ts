import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeCoreCommand } from '@aizign/adapter-testkit';
import {
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  type CoreClient,
} from '@aizign/protocol';
import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Config } from '../../src/config.ts';
import { OneShotCoreClient } from '../../src/core-client/one-shot-client.ts';
import { apply, Config as ConfigSchema, inject, name } from '../../src/index.ts';
import { preflight } from '../../src/lifecycle/preflight.ts';
import { adapterCodes as codes } from '../../src/mapping/tool.ts';
import type { ParentTimingMeasurement } from '../../src/timing.ts';
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
    attemptId: 'attempt-1',
    role: 'implementation',
    artifactRevision: 'rev-a',
    candidateDigest: {
      algorithm: 'sha256',
      hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
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
  assert.equal(name, 'aizign-workflow-signal');
  assert.deepEqual(inject, ['tools']);
  const parsed = ConfigSchema({
    binary: '/x/aizign',
    stateDir: '/x/state',
    eventId: 'evt-1',
    workflowId: 'wf-1',
    assignmentId: 'as-impl',
    attemptId: 'attempt-1',
    role: 'review',
    artifactRevision: 'rev-a',
    candidateDigest: {
      algorithm: 'sha256',
      hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  });
  assert.equal(parsed.timeoutMs, 15_000);
  assert.throws(() => ConfigSchema({ binary: '/x/aizign' } as Config));
});

test('preflight accepts a compatible core and rejects an incompatible or unreachable one', async () => {
  const fake = fakeCoreCommand();
  const ok = new OneShotCoreClient({ ...fake, stateDir: '/unused', timeoutMs: 5_000 });
  const timing: unknown[] = [];
  const info = await preflight(ok, {
    timingSink: (measurement) => {
      timing.push(measurement);
    },
  });
  assert.equal(info.protocolVersion, 1);
  assert.equal(timing.length, 1);
  assert.deepEqual(timing[0], {
    operation_kind: 'preflight',
    preflight_ms: (timing[0] as { preflight_ms: number }).preflight_ms,
    outcome: 'ok',
  });
  assert.equal(typeof (timing[0] as { preflight_ms: number }).preflight_ms, 'number');

  const submitOnly = new OneShotCoreClient({
    ...fake,
    env: { AIZIGN_FAKE_CAPABILITIES: CAPABILITY_WORKFLOW_SIGNAL_SUBMIT },
    stateDir: '/unused',
    timeoutMs: 5_000,
  });
  assert.deepEqual(
    (
      await preflight(submitOnly, {
        timingSink: async () => {
          throw new Error('timing sink unavailable');
        },
      })
    ).capabilities,
    [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
    'the model-visible submit tool must not require the separate control-plane capability',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const reconcileOnly = new OneShotCoreClient({
    ...fake,
    env: { AIZIGN_FAKE_CAPABILITIES: CAPABILITY_WORKFLOW_SIGNAL_RECONCILE },
    stateDir: '/unused',
    timeoutMs: 5_000,
  });
  const missingCapabilityTiming: ParentTimingMeasurement[] = [];
  await assert.rejects(
    preflight(reconcileOnly, {
      timingSink: (measurement) => {
        missingCapabilityTiming.push(measurement);
      },
    }),
    (error: unknown) => {
      return error instanceof HarnessError && error.code === codes.INCOMPATIBLE;
    },
  );
  assert.equal(missingCapabilityTiming[0]?.error_code, 'CAPABILITY_UNSUPPORTED');

  const future = new OneShotCoreClient({
    ...fake,
    env: { AIZIGN_FAKE_HELLO_PROTOCOL_VERSION: '2' },
    stateDir: '/unused',
    timeoutMs: 5_000,
  });
  const versionTiming: ParentTimingMeasurement[] = [];
  await assert.rejects(
    preflight(future, {
      timingSink: (measurement) => {
        versionTiming.push(measurement);
      },
    }),
    (error: unknown) => {
      return error instanceof HarnessError && error.code === codes.INCOMPATIBLE;
    },
  );
  assert.equal(versionTiming[0]?.error_code, 'PROTOCOL_VERSION_UNSUPPORTED');

  const unrecognizedPeerCode = {
    async hello() {
      return {
        kind: 'error',
        code: 'PRIVATE_FRAGMENT_ENCODED_DATA',
        message: 'synthetic peer diagnostic',
      } as const;
    },
  } as unknown as CoreClient;
  const peerCodeTiming: ParentTimingMeasurement[] = [];
  await assert.rejects(
    preflight(unrecognizedPeerCode, {
      timingSink: (measurement) => {
        peerCodeTiming.push(measurement);
      },
    }),
    (error: unknown) => {
      return error instanceof HarnessError && error.code === codes.UNAVAILABLE;
    },
  );
  assert.equal(peerCodeTiming.length, 1);
  assert.equal(peerCodeTiming[0]?.error_code, undefined);
  assert.ok(!JSON.stringify(peerCodeTiming).includes('PRIVATE_FRAGMENT_ENCODED_DATA'));
  await assert.rejects(
    preflight(unrecognizedPeerCode, {
      timingSink: async () => {
        throw new Error('timing sink unavailable');
      },
    }),
    (error: unknown) => {
      return error instanceof HarnessError && error.code === codes.UNAVAILABLE;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const silent = new OneShotCoreClient({
    ...fake,
    env: { AIZIGN_FAKE_FAULT: 'no-response' },
    stateDir: '/unused',
    timeoutMs: 5_000,
  });
  await assert.rejects(preflight(silent), (error: unknown) => {
    return error instanceof HarnessError && error.code === codes.UNAVAILABLE;
  });
});

test('apply runs the preflight and registers exactly one scope-bound tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-plugin-'));
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
        binary: fakeBinary(join(root, 'v2'), { AIZIGN_FAKE_HELLO_PROTOCOL_VERSION: '2' }),
      }),
      (error: unknown) => error instanceof HarnessError && error.code === codes.INCOMPATIBLE,
    );
    assert.equal(incompatible.registered.length, 0);

    // Not an aizign at all: fails closed as unavailable.
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
