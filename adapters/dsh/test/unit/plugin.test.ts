import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeCoreExecutable, readFakeRequests } from '@aizign/adapter-testkit';
import {
  CAPABILITY_WORKFLOW_SIGNAL_RECONCILE,
  CAPABILITY_WORKFLOW_SIGNAL_SUBMIT,
  type CoreClient,
  checkCompatibility,
} from '@aizign/protocol';
import { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { createProcessProfileRegistry } from '../../../../spec/process/v1/fixtures/registry.mjs';
import type { Config } from '../../src/config.ts';
import { OneShotCoreClient } from '../../src/core-client/one-shot-client.ts';
import * as adapterPlugin from '../../src/index.ts';
import { apply, Config as ConfigSchema, inject, name } from '../../src/index.ts';
import { preflight, RECONCILIATION_REQUIRED } from '../../src/lifecycle/preflight.ts';
import { adapterCodes as codes } from '../../src/mapping/tool.ts';
import type { ParentTimingMeasurement } from '../../src/timing.ts';
import { fakeBinary } from '../helpers/fake-dsh.ts';

/** A fake that wraps the fake core script so `binary` alone is enough. */
function fakeBinaryConfig(stateDir: string): Config {
  return {
    binary: '/unused/fake-core',
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
    trustedSignalValues: {
      artifactRef: 'artifact:implementation',
      blockedShortErrorCode: 'BLOCKED_BY_CONTROL_PLANE',
    },
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
    trustedSignalValues: { blockedShortErrorCode: 'BLOCKED_BY_CONTROL_PLANE' },
  });
  assert.equal(parsed.timeoutMs, 15_000);
  assert.throws(() => ConfigSchema({ binary: '/x/aizign' } as Config));
});

test('direct Cordis Fiber preserves the cause-free trusted-config failure before effects', async () => {
  const context = new Context();
  let registrations = 0;
  const disposeTools = context.provide('tools', {
    register() {
      registrations += 1;
      return () => undefined;
    },
  });
  const canary = 'credential-synthetic-user-password-private-canary-lowercase';
  const config = {
    ...fakeBinaryConfig('/unused/direct-cordis-state'),
    binary: '/unused/direct-cordis-binary',
    trustedSignalValues: {
      artifactRef: 'artifact:direct-cordis',
      blockedShortErrorCode: canary,
    },
  };
  try {
    await assert.rejects(
      Promise.resolve(context.plugin(adapterPlugin, config)),
      (error: unknown) => {
        return (
          error instanceof HarnessError &&
          error.code === 'INVALID_EXPECTATION' &&
          error.message === 'Aizign rejected invalid trusted signal configuration' &&
          !('cause' in error) &&
          !String(error.stack).includes(canary) &&
          !JSON.stringify(
            Object.fromEntries(
              Reflect.ownKeys(error).map((key) => [
                typeof key === 'symbol' ? key.toString() : key,
                Reflect.getOwnPropertyDescriptor(error, key)?.value,
              ]),
            ),
          ).includes(canary)
        );
      },
    );
    assert.equal(registrations, 0);
  } finally {
    await disposeTools();
  }
});

test('preflight accepts a compatible core and rejects an incompatible or unreachable one', async () => {
  const processCases = createProcessProfileRegistry('dsh-plugin');
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-preflight-'));
  const command = fakeCoreExecutable(join(root, 'bin'));
  const ok = new OneShotCoreClient({ command, stateDir: '/unused', timeoutMs: 5_000 });
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

  const reconciliationInvocationLog = join(root, 'reconciliation-check-invocations.log');
  const submitOnly = new OneShotCoreClient({
    command: fakeCoreExecutable(join(root, 'submit-only'), {
      capabilities: [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
      invocationLog: reconciliationInvocationLog,
    }),
    stateDir: '/unused',
    timeoutMs: 5_000,
  });
  const submitOnlyInfo = await preflight(submitOnly, {
    timingSink: async () => {
      throw new Error('timing sink unavailable');
    },
  });
  assert.deepEqual(
    submitOnlyInfo.capabilities,
    [CAPABILITY_WORKFLOW_SIGNAL_SUBMIT],
    'the model-visible submit tool must not require the separate control-plane capability',
  );
  assert.equal(
    checkCompatibility(submitOnlyInfo, RECONCILIATION_REQUIRED)?.reason,
    'missing_capability',
    'adapter-reconcile-capability-missing',
  );
  assert.equal(
    readFileSync(reconciliationInvocationLog, 'utf8').trim().split('\n').length,
    1,
    'the caller-local reconciliation check sends no reconcile request',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const reconcileOnly = new OneShotCoreClient({
    command: fakeCoreExecutable(join(root, 'reconcile-only'), {
      capabilities: [CAPABILITY_WORKFLOW_SIGNAL_RECONCILE],
    }),
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
  assert.deepEqual(missingCapabilityTiming[0], {
    operation_kind: 'preflight',
    preflight_ms: missingCapabilityTiming[0]?.preflight_ms,
    outcome: 'rejected',
  });
  processCases.record('hello-missing-capability');

  const future = new OneShotCoreClient({
    command: fakeCoreExecutable(join(root, 'future-version'), {
      helloProtocolVersion: 2,
    }),
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
  assert.deepEqual(versionTiming[0], {
    operation_kind: 'preflight',
    preflight_ms: versionTiming[0]?.preflight_ms,
    outcome: 'rejected',
  });
  processCases.record('hello-future-operation');
  processCases.complete();

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
    command: fakeCoreExecutable(join(root, 'silent'), { fault: 'no-response' }),
    stateDir: '/unused',
    timeoutMs: 5_000,
  });
  await assert.rejects(preflight(silent), (error: unknown) => {
    return error instanceof HarnessError && error.code === codes.UNAVAILABLE;
  });
  rmSync(root, { recursive: true, force: true });
});

test('apply registers one scope-bound tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aizign-dsh-plugin-'));
  try {
    const ctx = fakeContext();
    const config = fakeBinaryConfig(join(root, 'state'));
    await apply(ctx, { ...config, binary: fakeBinary(root) });
    assert.equal(ctx.registered.length, 1);
    assert.ok(ctx.registered[0], 'adapter-native-integration-absent');
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
    const requestsBeforeLocalFailure = readFakeRequests(config.stateDir).length;
    await assert.rejects(
      tool?.execute({ kind: 'blocked', shortErrorCode: 'MODEL_CHOICE' }, exec),
      (error: unknown) => error instanceof HarnessError && error.code === 'INVALID_SIGNAL',
    );
    assert.equal(
      readFakeRequests(config.stateDir).length,
      requestsBeforeLocalFailure,
      'Protocol source failure is rejected before the registered tool reaches the core',
    );

    // Incompatible core: nothing is registered.
    const incompatible = fakeContext();
    await assert.rejects(
      apply(incompatible, {
        ...config,
        binary: fakeBinary(join(root, 'v2'), { helloProtocolVersion: 2 }),
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

    // Trusted-value validation is the first startup action and preserves the
    // exact cause-free adapter-owned error.
    const invalidInvocationLog = join(root, 'invalid-trusted-invocations.log');
    const invalidTrusted = fakeContext();
    await assert.rejects(
      apply(invalidTrusted, {
        ...config,
        binary: fakeBinary(join(root, 'invalid-trusted'), {
          invocationLog: invalidInvocationLog,
        }),
        trustedSignalValues: {
          ...config.trustedSignalValues,
          blockedShortErrorCode: 'private-lowercase-canary',
        },
      }),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === 'INVALID_EXPECTATION' &&
        error.message === 'Aizign rejected invalid trusted signal configuration' &&
        !('cause' in error) &&
        !JSON.stringify(error).includes('private-lowercase-canary'),
    );
    assert.equal(invalidTrusted.registered.length, 0);
    assert.equal(existsSync(invalidInvocationLog), false, 'invalid config must not run preflight');

    // Invalid identity in the configuration never reaches the binary.
    await assert.rejects(
      apply(fakeContext(), { ...config, binary: fakeBinary(root), eventId: 'bad id' }),
      (error: unknown) => error instanceof HarnessError && error.code === 'INVALID_EXPECTATION',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
