// Purpose-specific cases keep every sweep boundary reviewable in source.
export const JOURNAL_SCALE_CASES = [
  ...[0, 10, 100, 1_000, 9_999].map((entries) => ({
    name: `submit_accepted_${entries}`,
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'accepted',
    journal_entries_before_operation: entries,
    fixture_target: 'absent',
  })),
  ...[1, 10, 100, 1_000, 10_000].map((entries) => ({
    name: `submit_duplicate_${entries}`,
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'duplicate',
    journal_entries_before_operation: entries,
    fixture_target: 'exact',
  })),
  {
    name: 'submit_bound_exceeded_10000',
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'rejected',
    expected_error_code: 'JOURNAL_BOUND_EXCEEDED',
    journal_entries_before_operation: 10_000,
    fixture_target: 'absent',
  },
  ...[0, 10, 100, 1_000, 10_000].map((entries) => ({
    name: `lookup_absent_${entries}`,
    operation_kind: 'workflow.signal.reconcile',
    expected_outcome: 'absent',
    journal_entries_before_operation: entries,
    fixture_target: 'absent',
  })),
];

export const OUTCOME_CASES = [
  {
    name: 'submit_accepted',
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'accepted',
    journal_entries_before_operation: 100,
    fixture_target: 'absent',
  },
  {
    name: 'submit_duplicate',
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'duplicate',
    journal_entries_before_operation: 100,
    fixture_target: 'exact',
  },
  {
    name: 'submit_rejected',
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'rejected',
    expected_error_code: 'REVISION_MISMATCH',
    journal_entries_before_operation: 100,
    fixture_target: 'absent',
    request_variant: 'expectation_mismatch',
  },
  {
    name: 'submit_conflict',
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'conflict',
    expected_error_code: 'EVENT_CONFLICT',
    journal_entries_before_operation: 100,
    fixture_target: 'exact',
    request_variant: 'changed_signal',
  },
  {
    name: 'submit_bound_exceeded',
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'rejected',
    expected_error_code: 'JOURNAL_BOUND_EXCEEDED',
    journal_entries_before_operation: 10_000,
    fixture_target: 'absent',
  },
  {
    name: 'lookup_accepted',
    operation_kind: 'workflow.signal.reconcile',
    expected_outcome: 'accepted',
    journal_entries_before_operation: 100,
    fixture_target: 'exact',
  },
  {
    name: 'lookup_conflict',
    operation_kind: 'workflow.signal.reconcile',
    expected_outcome: 'conflict',
    journal_entries_before_operation: 100,
    fixture_target: 'exact',
    request_variant: 'changed_signal',
  },
  {
    name: 'lookup_absent',
    operation_kind: 'workflow.signal.reconcile',
    expected_outcome: 'absent',
    journal_entries_before_operation: 100,
    fixture_target: 'absent',
  },
  {
    name: 'lookup_unknown',
    operation_kind: 'workflow.signal.reconcile',
    expected_outcome: 'unknown',
    expected_error_code: 'JOURNAL_UNAVAILABLE',
    journal_entries_before_operation: null,
    fixture_target: 'missing',
  },
];

export const TRANSPORT_CASES = [
  ...[0, 100, 9_999].map((entries) => ({
    name: `accepted_${entries}`,
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'accepted',
    journal_entries_before_operation: entries,
    fixture_target: 'absent',
  })),
  ...[1, 100, 10_000].map((entries) => ({
    name: `duplicate_${entries}`,
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'duplicate',
    journal_entries_before_operation: entries,
    fixture_target: 'exact',
  })),
  {
    name: 'bound_exceeded_10000',
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'rejected',
    expected_error_code: 'JOURNAL_BOUND_EXCEEDED',
    journal_entries_before_operation: 10_000,
    fixture_target: 'absent',
  },
  ...[0, 100, 10_000].map((entries) => ({
    name: `lookup_absent_${entries}`,
    operation_kind: 'workflow.signal.reconcile',
    expected_outcome: 'absent',
    journal_entries_before_operation: entries,
    fixture_target: 'absent',
  })),
];

export const MAX_PAYLOAD_CASES = [
  {
    name: 'submit_accepted_1000_near_max',
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'accepted',
    journal_entries_before_operation: 1_000,
    fixture_target: 'absent',
    request_variant: 'near_max',
  },
  {
    name: 'submit_bound_exceeded_10000_near_max',
    operation_kind: 'workflow.signal.submit',
    expected_outcome: 'rejected',
    expected_error_code: 'JOURNAL_BOUND_EXCEEDED',
    journal_entries_before_operation: 10_000,
    fixture_target: 'absent',
    request_variant: 'near_max',
  },
  ...[1_000, 10_000].map((entries) => ({
    name: `lookup_accepted_${entries}_near_max`,
    operation_kind: 'workflow.signal.reconcile',
    expected_outcome: 'accepted',
    journal_entries_before_operation: entries,
    fixture_target: 'exact',
    fixture_variant: 'near_max',
    request_variant: 'near_max',
  })),
];

export const CONCURRENCY_LEVELS = [1, 2, 4, 8];
export const CONCURRENCY_MODES = ['same_state_dir', 'different_state_dir'];
export const CONCURRENCY_OPERATIONS = ['workflow.signal.submit', 'workflow.signal.reconcile'];
export const DSH_EVENT_COUNTS = [100, 1_000, 10_000];
export const CANONICAL_SCENARIOS = ['assignment_submit', 'assignment_unknown_reconcile'];

export function validateCase(benchmarkCase) {
  const entries = benchmarkCase.journal_entries_before_operation;
  if (benchmarkCase.fixture_target === 'missing') {
    if (entries !== null) throw new Error(`${benchmarkCase.name}: missing fixture must use null`);
    return;
  }
  if (!Number.isInteger(entries) || entries < 0 || entries > 10_000) {
    throw new Error(`${benchmarkCase.name}: invalid journal entry count ${String(entries)}`);
  }
  if (
    benchmarkCase.operation_kind === 'workflow.signal.submit' &&
    benchmarkCase.expected_outcome === 'accepted' &&
    entries >= 10_000
  ) {
    throw new Error(`${benchmarkCase.name}: accepted submit cannot start at the journal bound`);
  }
  if (benchmarkCase.expected_outcome === 'duplicate' && entries === 0) {
    throw new Error(`${benchmarkCase.name}: duplicate requires a seeded target`);
  }
  if (benchmarkCase.fixture_target === 'exact' && entries === 0) {
    throw new Error(`${benchmarkCase.name}: exact target requires at least one entry`);
  }
}

export function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentileValue * sorted.length));
  return sorted[Math.min(rank - 1, sorted.length - 1)];
}

export function summarizeValues(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  return {
    sample_count: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
    min: Math.min(...finite),
    max: Math.max(...finite),
  };
}

for (const benchmarkCase of [
  ...JOURNAL_SCALE_CASES,
  ...OUTCOME_CASES,
  ...TRANSPORT_CASES,
  ...MAX_PAYLOAD_CASES,
]) {
  validateCase(benchmarkCase);
}
