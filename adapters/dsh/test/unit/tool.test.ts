import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMetadataOnly } from '@aizign/adapter-testkit';
import {
  type CoreClient,
  codes,
  ProtocolError,
  type SubmitOutcome,
  type WorkflowSignalSubmitPayload,
} from '@aizign/protocol';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { SignalBinding, TrustedSignalValues } from '../../src/config.ts';
import { canonicalJson, sha256Hex } from '../../src/evidence/digest.ts';
import {
  adapterCodes,
  createSubmitWorkflowSignalTool,
  decodeArgs,
  newRequestId,
  TOOL_NAME,
  toolParameters,
  toPayload,
  toToolResult,
} from '../../src/mapping/tool.ts';
import { resolveTrustedSignalValues } from '../../src/mapping/trusted-values.ts';

const binding: SignalBinding = {
  eventId: 'evt-fixed',
  expected: {
    workflowId: 'wf-1',
    assignmentId: 'as-review',
    attemptId: 'attempt-review',
    role: 'review',
    artifactRevision: 'rev-a',
    candidateDigest: {
      algorithm: 'sha256',
      hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
};

const trustedSignalValues = {
  artifactRef: 'artifact:review',
  blockedShortErrorCode: 'BLOCKED_BY_CONTROL_PLANE',
} as const satisfies TrustedSignalValues;

function stubClient(
  outcome: SubmitOutcome,
): CoreClient & { calls: WorkflowSignalSubmitPayload[]; requestIds: string[] } {
  const calls: WorkflowSignalSubmitPayload[] = [];
  const requestIds: string[] = [];
  return {
    calls,
    requestIds,
    async hello() {
      throw new Error('not used');
    },
    async submitWorkflowSignal(requestId, payload) {
      calls.push(payload);
      requestIds.push(requestId);
      return outcome;
    },
    async reconcileWorkflowSignal() {
      throw new Error('not used');
    },
  };
}

const exec = {
  callId: 'call/abc 123',
  signal: new AbortController().signal,
} as unknown as ToolRunContext;

test('the model-visible input schema exposes no identity fields', () => {
  const schema = toolParameters('review') as {
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  const tool = createSubmitWorkflowSignalTool(
    stubClient({ kind: 'accepted', eventId: 'evt-fixed' }),
    binding,
    trustedSignalValues,
  );
  const modelVisibleInputDefinition = JSON.stringify({ description: tool.description, schema });
  assert.deepEqual(Object.keys(schema.properties).sort(), ['findingCount', 'kind']);
  assert.equal(schema.additionalProperties, false);
  const kinds = (schema.properties.kind as { enum: string[] }).enum;
  assert.deepEqual(kinds, ['review_passed', 'review_findings', 'blocked']);
  for (const identity of [
    'eventId',
    'workflowId',
    'assignmentId',
    'attemptId',
    'artifactRevision',
    'candidateDigest',
  ]) {
    assert.ok(!Object.hasOwn(schema.properties, identity), identity);
    assert.ok(!modelVisibleInputDefinition.includes(identity), identity);
  }
  for (const configuredValue of [
    binding.eventId,
    binding.expected.workflowId,
    binding.expected.assignmentId,
    binding.expected.attemptId,
    binding.expected.artifactRevision,
    binding.expected.candidateDigest.hex,
    trustedSignalValues.artifactRef,
    trustedSignalValues.blockedShortErrorCode,
  ]) {
    assert.ok(!modelVisibleInputDefinition.includes(configuredValue), configuredValue);
  }
});

test('arguments are decoded closed and bound to the configured identity', () => {
  const payload = toPayload(
    binding,
    trustedSignalValues,
    decodeArgs({ kind: 'review_findings', findingCount: 2 }, 'review'),
  );
  assert.equal(payload.signal.eventId, 'evt-fixed');
  assert.equal(payload.signal.workflowId, 'wf-1');
  assert.equal(payload.signal.attemptId, 'attempt-review');
  assert.equal(payload.signal.role, 'review');
  assert.equal(payload.signal.findingCount, 2);
  assert.equal(payload.signal.artifactRef, 'artifact:review');
  assert.deepEqual(payload.expected, binding.expected);
  assertMetadataOnly(payload);

  assert.throws(
    () => decodeArgs({ kind: 'review_passed', eventId: 'evt-mine' }, 'review'),
    (error: unknown) => {
      return (
        error instanceof HarnessError &&
        error.code === 'INVALID_SIGNAL' &&
        error.message === 'Aizign rejected invalid workflow signal input' &&
        !error.message.includes('eventId')
      );
    },
  );
  assert.throws(
    () => decodeArgs({ kind: 'blocked', shortErrorCode: 'MODEL_CHOICE' }, 'review'),
    (error: unknown) => error instanceof HarnessError && error.code === 'INVALID_SIGNAL',
  );
  assert.throws(
    () => decodeArgs({ kind: 'review_findings', artifactRef: 'model:value' }, 'review'),
    (error: unknown) => error instanceof HarnessError && error.code === 'INVALID_SIGNAL',
  );
  const privateMarker = 'synthetic-private-state/operator/workflow.jsonl';
  assert.throws(
    () => decodeArgs({ kind: 'review_passed', [privateMarker]: true }, 'review'),
    (error: unknown) => {
      return (
        error instanceof HarnessError &&
        error.code === 'INVALID_SIGNAL' &&
        error.message === 'Aizign rejected invalid workflow signal input' &&
        !('cause' in error) &&
        !error.message.includes(privateMarker)
      );
    },
  );
  assert.throws(
    () => decodeArgs({ kind: 'implementation_ready' }, 'review'),
    (error: unknown) => {
      return error instanceof HarnessError && error.code === 'INVALID_SIGNAL';
    },
  );
  assert.throws(() => decodeArgs('not an object', 'review'), HarnessError);
});

test('Protocol validation stays in the client encoder and maps safely at the tool boundary', async () => {
  const payload = toPayload(binding, trustedSignalValues, {
    kind: 'review_passed',
    findingCount: 3,
  });
  assert.equal(payload.signal.findingCount, 3, 'the mapper does not duplicate Protocol rules');

  const client = stubClient({ kind: 'accepted', eventId: binding.eventId });
  client.submitWorkflowSignal = async () => {
    throw new ProtocolError(
      codes.INVALID_SIGNAL,
      'synthetic-private-state/operator/workflow.jsonl',
    );
  };
  const tool = createSubmitWorkflowSignalTool(client, binding, trustedSignalValues);
  await assert.rejects(
    tool.execute({ kind: 'review_passed', findingCount: 3 }, exec),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === codes.INVALID_SIGNAL &&
      error.message === 'Aizign rejected invalid workflow signal input' &&
      !('cause' in error) &&
      !JSON.stringify(error).includes('synthetic-private-state'),
  );
});

test('request ids are adapter-owned nonces, never derived from the harness call id', () => {
  const ids = new Set([newRequestId(), newRequestId(), newRequestId()]);
  assert.equal(ids.size, 3);
  for (const id of ids) {
    assert.match(id, /^req-[0-9a-f-]{36}$/);
    assert.ok(!id.includes('call'), id);
  }
});

test('outcomes map to safe harness errors without forwarding protocol detail', async () => {
  assert.deepEqual(toToolResult({ kind: 'accepted', eventId: 'evt-fixed' }), {
    disposition: 'accepted',
    eventId: 'evt-fixed',
  });
  assert.deepEqual(toToolResult({ kind: 'duplicate', eventId: 'evt-fixed' }), {
    disposition: 'duplicate',
    eventId: 'evt-fixed',
  });
  assert.throws(
    () =>
      toToolResult({
        kind: 'rejected',
        code: 'JOURNAL_UNAVAILABLE',
        message: 'cannot open synthetic-private-state/operator/workflow.jsonl: permission denied',
      }),
    (error: unknown) => {
      return (
        error instanceof HarnessError &&
        error.code === 'JOURNAL_UNAVAILABLE' &&
        error.message === 'Aizign rejected the workflow signal' &&
        !error.message.includes('synthetic-private-state') &&
        !error.message.includes('permission denied')
      );
    },
  );

  const client = stubClient({
    kind: 'unknown',
    reason: 'reported_unknown',
    reportedCode: 'FUTURE_OUTCOME_UNKNOWN',
    detail: 'FUTURE_OUTCOME_UNKNOWN: synthetic-private-state/operator/workflow.jsonl',
  });
  const tool = createSubmitWorkflowSignalTool(client, binding, trustedSignalValues);
  assert.equal(tool.name, TOOL_NAME);
  await assert.rejects(
    tool.execute({ kind: 'review_passed', findingCount: 0 }, exec),
    (error: unknown) => {
      return (
        error instanceof HarnessError &&
        error.code === adapterCodes.OUTCOME_UNKNOWN &&
        error.message === 'Aizign could not determine the workflow signal outcome' &&
        !error.message.includes('FUTURE_OUTCOME_UNKNOWN') &&
        !error.message.includes('synthetic-private-state')
      );
    },
  );
  assert.equal(client.calls.length, 1, 'exactly one submission; no retry on unknown');
  assertMetadataOnly(client.calls[0]);
  assert.ok(
    !JSON.stringify(client.calls[0]).includes('call/abc'),
    'harness call ids never reach the payload',
  );
});

test('the tool renders and presents only identity and digests', () => {
  const tool = createSubmitWorkflowSignalTool(
    stubClient({ kind: 'accepted', eventId: 'evt-fixed' }),
    binding,
    trustedSignalValues,
  );
  const value = { disposition: 'accepted', eventId: 'evt-fixed' };
  assert.deepEqual(tool.output.render({ kind: 'review_passed' }, value), [
    { type: 'text', text: JSON.stringify(value) },
  ]);
  const meta = tool.output.presentationMeta?.(
    { kind: 'review_passed', findingCount: 0 },
    value,
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(meta).sort(), [
    'bindingDigest',
    'disposition',
    'eventId',
    'payloadDigest',
    'tool',
  ]);
  assert.equal(meta.tool, TOOL_NAME);
  assert.equal(meta.eventId, 'evt-fixed');
  assert.equal(meta.disposition, 'accepted');
  assert.match(String(meta.bindingDigest), /^[0-9a-f]{64}$/);
  assert.match(String(meta.payloadDigest), /^[0-9a-f]{64}$/);
  // Total even for arguments that could never have produced a result.
  const degraded = tool.output.presentationMeta?.('garbage', value) as Record<string, unknown>;
  assert.equal(degraded.payloadDigest, '');
});

test('trusted-value mapping covers every signal kind and pins the provenance key', () => {
  const implementationBinding: SignalBinding = {
    eventId: 'evt-golden',
    expected: {
      workflowId: 'wf-golden',
      assignmentId: 'as-golden',
      attemptId: 'attempt-golden',
      role: 'implementation',
      artifactRevision: 'rev-golden',
      candidateDigest: {
        algorithm: 'sha256',
        hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
  };
  const trusted = {
    artifactRef: 'artifact:golden',
    blockedShortErrorCode: 'BLOCKED_GOLDEN',
  } as const;
  const implementationReady = resolveTrustedSignalValues(implementationBinding, trusted, {
    kind: 'implementation_ready',
  });
  const canonicalRecord = canonicalJson({
    schemaVersion: 1,
    eventId: implementationBinding.eventId,
    expected: implementationBinding.expected,
    artifactRef: trusted.artifactRef,
    blockedShortErrorCode: trusted.blockedShortErrorCode,
  });
  assert.equal(
    canonicalRecord,
    '{"artifactRef":"artifact:golden","blockedShortErrorCode":"BLOCKED_GOLDEN","eventId":"evt-golden","expected":{"artifactRevision":"rev-golden","assignmentId":"as-golden","attemptId":"attempt-golden","candidateDigest":{"algorithm":"sha256","hex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"role":"implementation","workflowId":"wf-golden"},"schemaVersion":1}',
  );
  assert.equal(
    implementationReady.trustedValueMappingKey,
    sha256Hex(`aizign:dsh:trusted-signal-values:v1\n${canonicalRecord}`),
  );
  assert.equal(
    implementationReady.trustedValueMappingKey,
    '5c26aa27d3c344bb54671eac57ca71bf50349b44de322e0dc631d81793b626fc',
  );
  assert.equal(implementationReady.payload.signal.artifactRef, undefined);
  assert.equal(implementationReady.payload.signal.shortErrorCode, undefined);
  assert.equal(
    resolveTrustedSignalValues(implementationBinding, trusted, { kind: 'repair_submitted' }).payload
      .signal.artifactRef,
    'artifact:golden',
  );
  assert.equal(
    resolveTrustedSignalValues(implementationBinding, trusted, { kind: 'blocked' }).payload.signal
      .shortErrorCode,
    'BLOCKED_GOLDEN',
  );

  const reviewBinding: SignalBinding = {
    ...implementationBinding,
    expected: { ...implementationBinding.expected, role: 'review' },
  };
  assert.equal(
    resolveTrustedSignalValues(reviewBinding, trusted, { kind: 'review_findings' }).payload.signal
      .artifactRef,
    'artifact:golden',
  );
  assert.equal(
    resolveTrustedSignalValues(reviewBinding, trusted, { kind: 'review_passed' }).payload.signal
      .artifactRef,
    undefined,
  );
  const reviewPassed = resolveTrustedSignalValues(reviewBinding, trusted, {
    kind: 'review_passed',
  });
  const reviewPassedWithOtherConfiguredValue = resolveTrustedSignalValues(
    reviewBinding,
    { ...trusted, artifactRef: 'artifact:other' },
    { kind: 'review_passed' },
  );
  assert.deepEqual(reviewPassed.payload, reviewPassedWithOtherConfiguredValue.payload);
  assert.notEqual(
    reviewPassed.trustedValueMappingKey,
    reviewPassedWithOtherConfiguredValue.trustedValueMappingKey,
  );
  assert.equal(
    resolveTrustedSignalValues(
      reviewBinding,
      { blockedShortErrorCode: 'BLOCKED_GOLDEN' },
      { kind: 'review_findings' },
    ).payload.signal.artifactRef,
    undefined,
  );
});
