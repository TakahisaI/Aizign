import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMetadataOnly } from '@aizign/adapter-testkit';
import type { CoreClient, SubmitOutcome, WorkflowSignalSubmitPayload } from '@aizign/protocol';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { SignalBinding } from '../../src/config.ts';
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

test('the tool schema exposes no identity fields', () => {
  const schema = toolParameters('review') as {
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  const tool = createSubmitWorkflowSignalTool(
    stubClient({ kind: 'accepted', eventId: 'evt-fixed' }),
    binding,
  );
  const modelVisibleDefinition = JSON.stringify({ description: tool.description, schema });
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    'artifactRef',
    'findingCount',
    'kind',
    'shortErrorCode',
  ]);
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
    assert.ok(!modelVisibleDefinition.includes(identity), identity);
  }
  for (const configuredValue of [
    binding.eventId,
    binding.expected.workflowId,
    binding.expected.assignmentId,
    binding.expected.attemptId,
    binding.expected.artifactRevision,
    binding.expected.candidateDigest.hex,
  ]) {
    assert.ok(!modelVisibleDefinition.includes(configuredValue), configuredValue);
  }
});

test('arguments are decoded closed and bound to the configured identity', () => {
  const payload = toPayload(
    binding,
    decodeArgs({ kind: 'review_findings', findingCount: 2 }, 'review'),
  );
  assert.equal(payload.signal.eventId, 'evt-fixed');
  assert.equal(payload.signal.workflowId, 'wf-1');
  assert.equal(payload.signal.attemptId, 'attempt-review');
  assert.equal(payload.signal.role, 'review');
  assert.equal(payload.signal.findingCount, 2);
  assert.deepEqual(payload.expected, binding.expected);
  assertMetadataOnly(payload);

  assert.throws(
    () => decodeArgs({ kind: 'review_passed', eventId: 'evt-mine' }, 'review'),
    (error: unknown) => {
      return (
        error instanceof HarnessError &&
        error.code === 'INVALID_SIGNAL' &&
        /eventId/.test(error.message)
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

test('core rules are applied before any process is spawned', () => {
  // review_passed with a non-zero finding count is rejected by the same rule the core uses.
  assert.throws(
    () => toPayload(binding, { kind: 'review_passed', findingCount: 3 }),
    (error: unknown) => {
      return error instanceof HarnessError && error.code === 'INVALID_SIGNAL';
    },
  );
  assert.throws(
    () => toPayload(binding, { kind: 'blocked' }),
    (error: unknown) => {
      return error instanceof HarnessError && error.code === 'INVALID_SIGNAL';
    },
  );

  const privateMarker = 'synthetic-private-state/operator/workflow.jsonl';
  assert.throws(
    () =>
      toPayload(binding, {
        kind: 'review_findings',
        findingCount: 1,
        artifactRef: privateMarker,
      }),
    (error: unknown) => {
      return (
        error instanceof HarnessError &&
        error.code === 'INVALID_SIGNAL' &&
        error.message === 'Aizign rejected invalid workflow signal input' &&
        !('cause' in error) &&
        !JSON.stringify(error).includes(privateMarker)
      );
    },
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
    detail: 'JOURNAL_OUTCOME_UNKNOWN: synthetic-private-state/operator/workflow.jsonl',
  });
  const tool = createSubmitWorkflowSignalTool(client, binding);
  assert.equal(tool.name, TOOL_NAME);
  await assert.rejects(
    tool.execute({ kind: 'review_passed', findingCount: 0 }, exec),
    (error: unknown) => {
      return (
        error instanceof HarnessError &&
        error.code === adapterCodes.OUTCOME_UNKNOWN &&
        error.message === 'Aizign could not determine the workflow signal outcome' &&
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
