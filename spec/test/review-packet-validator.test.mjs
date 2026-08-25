import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const validator = join(root, 'scripts', 'validate-review-batch.mjs');
const baseSha = 'f'.repeat(40);
const targetSha = '1'.repeat(40);
const treeSha = '2'.repeat(40);

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function textDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function assignment(id, title, subjectIds) {
  return {
    perspective_id: id,
    title,
    question: `Does ${title} hold?`,
    failure_models: [`${title} fails`],
    subject_ids: [...subjectIds].sort(),
    required_checks: ['CONTRIBUTING.md', 'GOVERNANCE.md'].sort(),
    assignment_out_of_range: ['product runtime behavior'],
  };
}

function rehash(packets) {
  const context = packets[0].batch_context;
  const checkpoint = context.checkpoint;
  checkpoint.checkpoint_sha256 = digest(checkpoint.checkpoint_content);
  if (checkpoint.approval.decision === 'approved') {
    checkpoint.approval.approved_checkpoint_sha256 = checkpoint.checkpoint_sha256;
  }
  const contextSha = digest(context);
  const assignments = new Map(
    checkpoint.checkpoint_content.review_assignments.map((item) => [item.perspective_id, item]),
  );
  for (const packet of packets) {
    packet.batch_context = structuredClone(context);
    packet.batch_context_sha256 = contextSha;
    packet.assignment = structuredClone(assignments.get(packet.assignment.perspective_id));
    const packetForDigest = structuredClone(packet);
    delete packetForDigest.packet_sha256;
    packet.packet_sha256 = digest(packetForDigest);
  }
  return packets;
}

function makeBatch() {
  const assignments = [
    assignment('PA-1', 'governance and authority', [
      'CLM-AUTHORITY',
      'EVD-AUTHORITY',
      'RNG-PROCESS',
    ]),
    assignment('PA-2', 'executability and proportionality', [
      'CLM-ROUTINE',
      'EVD-ROUTINE',
      'RNG-LIFECYCLE',
    ]),
    assignment('PA-3', 'fixed context and containment', [
      'CLM-CONTEXT',
      'EVD-CONTEXT',
      'RNG-CONSUMER',
    ]),
  ];
  const checkpointContent = {
    schema: 'aizign.checkpoint/v1',
    checkpoint_id: 'issue-94-checkpoint-v1',
    workflow_revision: baseSha,
    change_class: 'Boundary change',
    contract_revision: 'issue-94-body-v1',
    contract_snapshot_id: 'SNAP-ISSUE-94',
    normative_authorities: [
      {
        authority_id: 'AUTH-CONTRIBUTING',
        path: 'CONTRIBUTING.md',
        revision: baseSha,
        section: 'Proposal-first changes',
        purpose: 'Controls contribution policy',
      },
      {
        authority_id: 'AUTH-GOVERNANCE',
        path: 'GOVERNANCE.md',
        revision: baseSha,
        section: 'Roles and decisions',
        purpose: 'Controls Maintainer authority',
      },
    ],
    canonical_owners: [
      {
        owner_id: 'OWNER-WORKFLOW',
        surface: 'Boundary workflow',
        path: 'docs/development/change-workflow.md',
      },
    ],
    duplicate_owners_to_remove: [],
    old_path_dispositions: [],
    claims: [
      {
        claim_id: 'CLM-AUTHORITY',
        statement: 'Maintainer authority remains separate.',
        authority_ids: ['AUTH-GOVERNANCE'],
        falsification: 'A Conductor can approve or merge.',
      },
      {
        claim_id: 'CLM-CONTEXT',
        statement: 'Every reviewer receives one shared context.',
        authority_ids: ['AUTH-CONTRIBUTING'],
        falsification: 'Two packets contain different batch context.',
      },
      {
        claim_id: 'CLM-ROUTINE',
        statement: 'Routine changes remain lightweight.',
        authority_ids: ['AUTH-CONTRIBUTING'],
        falsification: 'A Routine change requires a standing Breaker.',
      },
    ],
    ranges: [
      {
        range_id: 'RNG-CONSUMER',
        kind: 'consumer',
        value: 'coding agents',
        disposition: 'included',
        reason: 'Agents consume the workflow.',
        owner_or_follow_up: 'OWNER-WORKFLOW',
      },
      {
        range_id: 'RNG-LIFECYCLE',
        kind: 'lifecycle',
        value: 'review batch',
        disposition: 'included',
        reason: 'The change defines review batches.',
        owner_or_follow_up: 'OWNER-WORKFLOW',
      },
      {
        range_id: 'RNG-PROCESS',
        kind: 'commitment',
        value: 'PROCESS',
        disposition: 'included',
        reason: 'The change affects process governance.',
        owner_or_follow_up: 'OWNER-WORKFLOW',
      },
    ],
    evidence_requirements: [
      {
        evidence_id: 'EVD-AUTHORITY',
        subject_ids: ['CLM-AUTHORITY', 'RNG-PROCESS'],
        evidence_ref_ids: ['ARTIFACT-WORKFLOW'],
        method: 'Inspect governance and workflow roles.',
        expected_detection: 'Role crossover is established.',
        owner: 'PA-1',
      },
      {
        evidence_id: 'EVD-CONTEXT',
        subject_ids: ['CLM-CONTEXT', 'RNG-CONSUMER'],
        evidence_ref_ids: ['ARTIFACT-WORKFLOW'],
        method: 'Compare every packet context.',
        expected_detection: 'Different context fails validation.',
        owner: 'PA-3',
      },
      {
        evidence_id: 'EVD-ROUTINE',
        subject_ids: ['CLM-ROUTINE', 'RNG-LIFECYCLE'],
        evidence_ref_ids: ['ARTIFACT-WORKFLOW'],
        method: 'Inspect Routine requirements.',
        expected_detection: 'Standing review burden is established.',
        owner: 'PA-2',
      },
    ],
    review_assignments: assignments,
    implementation_scope: 'review-only',
    known_evidence_gaps: [],
  };
  const issue = 'Exact Issue #94 body';
  const pr = 'Exact PR #95 body';
  const manualInstructions = [
    'Manual bootstrap: use one fresh session per packet, inspect only the assigned subjects,',
    'return findings only, and use another fresh session for adjudication.',
  ].join(' ');
  const context = {
    schema: 'aizign.review-batch-context/v1',
    context_id: 'issue-94-pr-95-context-v1',
    created_at: '2026-08-25T00:00:00Z',
    repository: 'TakahisaI/Aizign',
    workflow: {
      mode: 'bootstrap',
      procedure_path: null,
      review_packet_path: null,
      revision: baseSha,
    },
    execution_adapter: {
      mode: 'manual',
      instruction_constraint_id: 'EXEC-MANUAL-BOOTSTRAP',
    },
    controlling_authorities: checkpointContent.normative_authorities,
    target: {
      sha: targetSha,
      tree_sha: treeSha,
      pull_request_number: 95,
      pull_request_head_sha: targetSha,
      base_ref: 'main',
      base_sha: baseSha,
      merge_base_sha: baseSha,
      changed_files: ['.github/ISSUE_TEMPLATE/proposal.yml', 'docs/development/change-workflow.md'],
    },
    checkpoint: {
      checkpoint_content: checkpointContent,
      checkpoint_sha256: digest(checkpointContent),
      approval: {
        decision: 'approved',
        approved_checkpoint_sha256: digest(checkpointContent),
        maintainer_identity: 'TakahisaI',
        approved_at: '2026-08-25T00:00:00Z',
        approval_reference: 'https://github.com/TakahisaI/Aizign/issues/94',
      },
    },
    issue_pr_snapshots: [
      {
        snapshot_id: 'SNAP-ISSUE-94',
        kind: 'issue',
        number: 94,
        source_reference: 'https://github.com/TakahisaI/Aizign/issues/94',
        captured_at: '2026-08-25T00:00:00Z',
        content: issue,
        artifact_path: null,
        sha256: textDigest(issue),
      },
      {
        snapshot_id: 'SNAP-PR-95',
        kind: 'pull_request',
        number: 95,
        source_reference: 'https://github.com/TakahisaI/Aizign/pull/95',
        captured_at: '2026-08-25T00:00:00Z',
        content: pr,
        artifact_path: null,
        sha256: textDigest(pr),
      },
    ],
    external_constraints: [
      {
        constraint_id: 'EXEC-MANUAL-BOOTSTRAP',
        purpose: 'Exact manual Breaker and Adjudicator execution instructions',
        source_reference: 'Issue #94 bootstrap packet',
        captured_at: '2026-08-25T00:00:00Z',
        content: manualInstructions,
        artifact_path: null,
        sha256: textDigest(manualInstructions),
      },
    ],
    evidence: [
      {
        evidence_id: 'ARTIFACT-WORKFLOW',
        kind: 'repository',
        path: 'docs/development/change-workflow.md',
        revision: targetSha,
        purpose: 'Candidate workflow under review',
      },
    ],
    coverage: [
      { subject_id: 'CLM-AUTHORITY', perspective_ids: ['PA-1'] },
      { subject_id: 'CLM-CONTEXT', perspective_ids: ['PA-3'] },
      { subject_id: 'CLM-ROUTINE', perspective_ids: ['PA-2'] },
      { subject_id: 'EVD-AUTHORITY', perspective_ids: ['PA-1'] },
      { subject_id: 'EVD-CONTEXT', perspective_ids: ['PA-3'] },
      { subject_id: 'EVD-ROUTINE', perspective_ids: ['PA-2'] },
      { subject_id: 'RNG-CONSUMER', perspective_ids: ['PA-3'] },
      { subject_id: 'RNG-LIFECYCLE', perspective_ids: ['PA-2'] },
      { subject_id: 'RNG-PROCESS', perspective_ids: ['PA-1'] },
    ],
    global_out_of_range: [
      {
        area: 'product/runtime behavior',
        reason: 'The candidate changes process artifacts only.',
        owner_or_follow_up: 'none',
      },
    ],
    known_evidence_gaps: [],
  };
  const packets = assignments.map((item) => ({
    schema: 'aizign.review-packet/v1',
    packet_id: `issue-94-pr-95-${item.perspective_id.toLowerCase()}`,
    packet_sha256: `sha256:${'0'.repeat(64)}`,
    batch_id: 'issue-94-pr-95-v1',
    batch_context_sha256: `sha256:${'0'.repeat(64)}`,
    batch_context: context,
    assignment: item,
  }));
  return rehash(packets);
}

function run(paths, cwd = root) {
  return spawnSync(process.execPath, [validator, ...paths], {
    cwd,
    encoding: 'utf8',
  });
}

function writePackets(dir, packets) {
  return packets.map((packet, index) => {
    const file = join(dir, `packet-${index + 1}.json`);
    writeFileSync(file, `${JSON.stringify(packet, null, 2)}\n`);
    return file;
  });
}

function assertRejected(packets, pattern, cwd = root) {
  const dir = mkdtempSync(join(tmpdir(), 'aizign-review-batch-'));
  try {
    const result = run(writePackets(dir, rehash(packets)), cwd);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, pattern);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('review batch validator accepts one complete fixed-context batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aizign-review-batch-'));
  try {
    const result = run(writePackets(dir, makeBatch()));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /validated 3 packet\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review batch validator rejects a digest-valid but structurally empty packet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aizign-review-batch-'));
  try {
    const file = join(dir, 'invalid.json');
    writeFileSync(
      file,
      `${JSON.stringify({
        batch_context: {},
        batch_context_sha256:
          'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        packet_sha256: 'sha256:60c7dd85a6e2625176952ab8321e532c087dac349a619261e1ab64b930d0bc21',
      })}\n`,
    );
    const result = run([file]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /schema validation failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review batch validator rejects separately valid packets with different context', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aizign-review-batch-'));
  try {
    const packets = makeBatch();
    packets[1] = structuredClone(packets[1]);
    packets[1].batch_context.context_id = 'issue-94-pr-95-context-v2';
    packets[1].batch_context_sha256 = digest(packets[1].batch_context);
    const forDigest = structuredClone(packets[1]);
    delete forDigest.packet_sha256;
    packets[1].packet_sha256 = digest(forDigest);
    const result = run(writePackets(dir, packets));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /same batch ID and canonical batch context/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review batch validator requires exactly one packet per perspective', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aizign-review-batch-'));
  try {
    const result = run(writePackets(dir, makeBatch().slice(0, 2)));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one packet for every perspective/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, field, value, pattern] of [
  [
    'empty identity',
    'maintainer_identity',
    '   ',
    /maintainer_identity must be a non-blank string/,
  ],
  ['empty timestamp', 'approved_at', '   ', /schema validation failed|valid RFC 3339 timestamp/],
  ['empty reference', 'approval_reference', '   ', /approval_reference must be a non-blank string/],
  ['malformed timestamp', 'approved_at', '2026-99-25T00:00:00Z', /valid RFC 3339 timestamp/],
]) {
  test(`review batch validator rejects approved checkpoint with ${name}`, () => {
    const packets = makeBatch();
    packets[0].batch_context.checkpoint.approval[field] = value;
    assertRejected(packets, pattern);
  });
}

test('review batch validator requires evidence for every claim', () => {
  const packets = makeBatch();
  const requirements =
    packets[0].batch_context.checkpoint.checkpoint_content.evidence_requirements;
  const requirement = requirements.find(
    (item) => item.evidence_id === 'EVD-CONTEXT',
  );
  requirement.subject_ids = ['RNG-CONSUMER'];
  assertRejected(packets, /claim CLM-CONTEXT has no evidence requirement/);
});

test('review batch validator requires evidence references to resolve', () => {
  const packets = makeBatch();
  const requirements =
    packets[0].batch_context.checkpoint.checkpoint_content.evidence_requirements;
  requirements[0].evidence_ref_ids = ['EVIDENCE-MISSING'];
  assertRejected(packets, /references unknown evidence EVIDENCE-MISSING/);
});

test('review batch validator requires every known evidence gap to be assigned', () => {
  const packets = makeBatch();
  const gap = {
    gap_id: 'GAP-UNASSIGNED',
    description: 'One missing observation remains.',
    owner_or_follow_up: 'Issue #100',
  };
  packets[0].batch_context.checkpoint.checkpoint_content.known_evidence_gaps.push(gap);
  packets[0].batch_context.known_evidence_gaps.push(structuredClone(gap));
  assertRejected(packets, /missing coverage for GAP-UNASSIGNED/);
});

test('review batch validator requires manual execution for bootstrap', () => {
  const packets = makeBatch();
  const constraint = packets[0].batch_context.external_constraints[0];
  packets[0].batch_context.execution_adapter = {
    mode: 'skill',
    instruction_constraint_id: constraint.constraint_id,
    skill_name: 'aizign-break',
    skill_version: 'v2',
    skill_sha256: constraint.sha256,
  };
  assertRejected(packets, /bootstrap batches must use the frozen manual execution adapter/);
});

test('review batch validator rejects bootstrap authorities at the target SHA', () => {
  const packets = makeBatch();
  const context = packets[0].batch_context;
  for (const authority of context.controlling_authorities) authority.revision = targetSha;
  for (const authority of context.checkpoint.checkpoint_content.normative_authorities) {
    authority.revision = targetSha;
  }
  assertRejected(packets, /bootstrap controlling authorities must use the base SHA/);
});

test('review batch validator requires a matching pull-request snapshot', () => {
  const packets = makeBatch();
  packets[0].batch_context.issue_pr_snapshots = packets[0].batch_context.issue_pr_snapshots.filter(
    (item) => item.kind !== 'pull_request',
  );
  assertRejected(packets, /exactly one matching pull-request snapshot/);
});

test('review batch validator rejects the wrong pull-request snapshot number', () => {
  const packets = makeBatch();
  packets[0].batch_context.issue_pr_snapshots.find(
    (item) => item.kind === 'pull_request',
  ).number = 96;
  assertRejected(packets, /exactly one matching pull-request snapshot/);
});

test('review batch validator requires the contract snapshot to exist', () => {
  const packets = makeBatch();
  packets[0].batch_context.checkpoint.checkpoint_content.contract_snapshot_id =
    'SNAP-ISSUE-MISSING';
  assertRejected(packets, /contract snapshot SNAP-ISSUE-MISSING does not exist/);
});

test('review batch validator rejects an artifact symlink that escapes the repository root', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'aizign-review-root-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'aizign-review-outside-'));
  try {
    const outside = join(outsideDir, 'manual.txt');
    const content = 'outside manual instruction bytes';
    writeFileSync(outside, content);
    symlinkSync(outside, join(repoDir, 'manual.txt'));

    const packets = makeBatch();
    const constraint = packets[0].batch_context.external_constraints[0];
    constraint.content = null;
    constraint.artifact_path = 'manual.txt';
    constraint.sha256 = textDigest(content);
    const paths = writePackets(repoDir, rehash(packets));
    const result = run(paths, repoDir);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /outside the repository root through a symlink/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
