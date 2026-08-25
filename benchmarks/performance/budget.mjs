export const PR_SMOKE_BUDGET_VERSION = 1;

const NATIVE_BASELINE = {
  commit_sha: 'ee93496eb0a7a08666770b0bffcc2aa33b23e79a',
  workflow_run_ids: [32792032577, 32792661803, 32792663958],
  run_count: 3,
  samples_per_point: 20,
};

const TRANSPORT_BASELINE_P95_MS = {
  accepted_0: { handler_total_ms: 400.322, spawn_to_exit_ms: 401.957 },
  accepted_100: { handler_total_ms: 74.486, spawn_to_exit_ms: 75.826 },
  accepted_9999: { handler_total_ms: 231.045, spawn_to_exit_ms: 233.181 },
  duplicate_1: { handler_total_ms: 106.79, spawn_to_exit_ms: 108.937 },
  duplicate_100: { handler_total_ms: 78.936, spawn_to_exit_ms: 80.502 },
  duplicate_10000: { handler_total_ms: 117.514, spawn_to_exit_ms: 119.53 },
  bound_exceeded_10000: { handler_total_ms: 136.53, spawn_to_exit_ms: 139.869 },
  lookup_absent_0: { handler_total_ms: 0.338, spawn_to_exit_ms: 2.383 },
  lookup_absent_100: { handler_total_ms: 0.874, spawn_to_exit_ms: 2.785 },
  lookup_absent_10000: { handler_total_ms: 58.685, spawn_to_exit_ms: 62.002 },
};

const SCENARIO_BUDGETS = [
  {
    id: 'scenario/assignment_submit/e2e',
    sweep: 'scenarios',
    case_name: 'assignment_submit',
    metric: 'aizign_end_to_end_ms',
    limit_ms: 5_000,
    baseline_p95_ms: 828.076,
  },
  {
    id: 'scenario/assignment_unknown_reconcile/e2e',
    sweep: 'scenarios',
    case_name: 'assignment_unknown_reconcile',
    metric: 'aizign_end_to_end_ms',
    limit_ms: 7_000,
    baseline_p95_ms: 320.318,
  },
  ...[
    ['assignment_submit', 3.073],
    ['assignment_unknown_reconcile', 3.356],
  ].map(([caseName, baseline]) => ({
    id: `scenario/${caseName}/hello`,
    sweep: 'scenario-operations',
    case_name: caseName,
    operation_name: 'hello',
    metric: 'spawn_to_exit_ms',
    limit_ms: 1_000,
    baseline_p95_ms: baseline,
  })),
  ...[
    ['assignment_submit', 3.275],
    ['assignment_unknown_reconcile', 3.469],
  ].map(([caseName, baseline]) => ({
    id: `scenario/${caseName}/preflight`,
    sweep: 'scenario-operations',
    case_name: caseName,
    operation_name: 'preflight',
    metric: 'preflight_ms',
    limit_ms: 1_000,
    baseline_p95_ms: baseline,
  })),
  {
    id: 'scenario/assignment_submit/submit',
    sweep: 'scenario-operations',
    case_name: 'assignment_submit',
    operation_name: 'submit',
    metric: 'spawn_to_exit_ms',
    limit_ms: 5_000,
    baseline_p95_ms: 824.695,
  },
  {
    id: 'scenario/assignment_unknown_reconcile/submit_lost_ack',
    sweep: 'scenario-operations',
    case_name: 'assignment_unknown_reconcile',
    operation_name: 'submit_lost_ack',
    metric: 'spawn_to_exit_ms',
    limit_ms: 5_000,
    baseline_p95_ms: 315.271,
  },
  {
    id: 'scenario/assignment_unknown_reconcile/lookup',
    sweep: 'scenario-operations',
    case_name: 'assignment_unknown_reconcile',
    operation_name: 'lookup',
    metric: 'spawn_to_exit_ms',
    limit_ms: 3_000,
    baseline_p95_ms: 4.521,
  },
];

const CONCURRENCY_BASELINE_P95_MS = {
  submit_same_state_dir_1: 242.703,
  submit_same_state_dir_2: 99.071,
  submit_different_state_dir_1: 449.382,
  submit_different_state_dir_2: 196.716,
};

const STAGE_METRICS = [
  'journal_open_ms',
  'committed_prefix_read_ms',
  'committed_prefix_hash_ms',
  'committed_prefix_decode_ms',
  'replay_ms',
  'append_sync_ms',
  'publish_prefix_hash_ms',
  'handler_total_ms',
  'spawn_to_exit_ms',
  'preflight_ms',
  'aizign_end_to_end_ms',
  'batch_total_ms',
];

function transportBudgets() {
  return Object.entries(TRANSPORT_BASELINE_P95_MS).flatMap(([caseName, baseline]) => {
    return [
      {
        id: `transport/${caseName}/handler`,
        sweep: 'transport',
        case_name: caseName,
        transport: 'rust_direct',
        metric: 'handler_total_ms',
        limit_ms: 3_000,
        baseline_p95_ms: baseline.handler_total_ms,
      },
      {
        id: `transport/${caseName}/spawn`,
        sweep: 'transport',
        case_name: caseName,
        transport: 'rust_direct',
        metric: 'spawn_to_exit_ms',
        limit_ms: 5_000,
        baseline_p95_ms: baseline.spawn_to_exit_ms,
      },
    ];
  });
}

function concurrencyBudgets() {
  return Object.entries(CONCURRENCY_BASELINE_P95_MS).map(([caseName, baseline]) => ({
    id: `concurrency/${caseName}/batch`,
    sweep: 'concurrency',
    case_name: caseName,
    metric: 'batch_total_ms',
    limit_ms: 5_000,
    baseline_p95_ms: baseline,
  }));
}

export const PR_SMOKE_BUDGETS = [
  ...transportBudgets(),
  ...SCENARIO_BUDGETS,
  ...concurrencyBudgets(),
];

function matches(aggregate, budget) {
  return (
    aggregate.sweep === budget.sweep &&
    aggregate.case_name === budget.case_name &&
    (budget.transport === undefined || aggregate.transport === budget.transport) &&
    (budget.operation_name === undefined || aggregate.operation_name === budget.operation_name)
  );
}

function stageAttribution(aggregate) {
  return Object.fromEntries(
    STAGE_METRICS.flatMap((metric) => {
      const summary = aggregate?.metrics?.[metric];
      return summary === undefined ? [] : [[metric, summary.p95]];
    }),
  );
}

export function evaluatePrSmokeBudgets(aggregates, budgets = PR_SMOKE_BUDGETS) {
  const evaluations = budgets.map((budget) => {
    const aggregate = aggregates.find((candidate) => matches(candidate, budget));
    const metric = aggregate?.metrics?.[budget.metric];
    const measured = metric?.max;
    const status = Number.isFinite(measured) && measured <= budget.limit_ms ? 'pass' : 'fail';
    return {
      id: budget.id,
      metric: budget.metric,
      statistic: 'max',
      measured_ms: Number.isFinite(measured) ? measured : null,
      limit_ms: budget.limit_ms,
      baseline_p95_ms: budget.baseline_p95_ms,
      status,
      stage_attribution_p95_ms: stageAttribution(aggregate),
    };
  });
  const failed = evaluations.filter((evaluation) => evaluation.status === 'fail').length;
  return {
    version: PR_SMOKE_BUDGET_VERSION,
    status: failed === 0 ? 'pass' : 'fail',
    passed: evaluations.length - failed,
    failed,
    baseline: NATIVE_BASELINE,
    evaluations,
  };
}
