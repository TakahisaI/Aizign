import { readFileSync } from 'node:fs';
import {
  CANONICAL_SCENARIOS,
  PR_SMOKE_CASES,
  PR_SMOKE_CONCURRENCY_LEVELS,
  PR_SMOKE_CONCURRENCY_MODES,
  PR_SMOKE_CONCURRENCY_OPERATIONS,
} from './matrix.mjs';

export const PR_SMOKE_BUDGET_VERSION = 2;
export const PR_SMOKE_CONFIG = Object.freeze({
  profile: 'pr-smoke',
  warmup: 1,
  samples: 3,
  sweeps: Object.freeze(['transport', 'concurrency', 'scenarios']),
});

export const NATIVE_BASELINE_MANIFEST = JSON.parse(
  readFileSync(new URL('./native-baseline-v3.json', import.meta.url), 'utf8'),
);

const BASELINE = NATIVE_BASELINE_MANIFEST.highest_p95_ms;
const SCENARIO_OPERATION_NAMES = {
  assignment_submit: ['hello', 'preflight', 'submit'],
  assignment_unknown_reconcile: ['hello', 'preflight', 'submit_lost_ack', 'lookup'],
};

const STAGE_METRICS_MS = [
  'request_read_ms',
  'decode_ms',
  'journal_open_ms',
  'journal_load_decode_ms',
  'committed_prefix_read_ms',
  'committed_prefix_hash_ms',
  'committed_prefix_decode_ms',
  'replay_ms',
  'append_sync_ms',
  'publish_prefix_hash_ms',
  'response_encode_ms',
  'response_write_ms',
  'handler_total_ms',
  'spawn_to_exit_ms',
  'response_first_byte_ms',
  'preflight_ms',
  'aizign_end_to_end_ms',
  'batch_total_ms',
];
const STAGE_METRICS_US = ['decide_us'];

function transportBudgets() {
  return PR_SMOKE_CASES.flatMap(({ name: caseName }) => {
    const baseline = BASELINE.transport[caseName];
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

function scenarioBudgets() {
  return [
    {
      id: 'scenario/assignment_submit/e2e',
      sweep: 'scenarios',
      case_name: 'assignment_submit',
      metric: 'aizign_end_to_end_ms',
      limit_ms: 5_000,
      baseline_p95_ms: BASELINE.scenarios.assignment_submit,
    },
    {
      id: 'scenario/assignment_unknown_reconcile/e2e',
      sweep: 'scenarios',
      case_name: 'assignment_unknown_reconcile',
      metric: 'aizign_end_to_end_ms',
      limit_ms: 7_000,
      baseline_p95_ms: BASELINE.scenarios.assignment_unknown_reconcile,
    },
    ...CANONICAL_SCENARIOS.flatMap((caseName) =>
      SCENARIO_OPERATION_NAMES[caseName].map((operationName) => {
        const metric = operationName === 'preflight' ? 'preflight_ms' : 'spawn_to_exit_ms';
        const limit =
          operationName === 'hello' || operationName === 'preflight'
            ? 1_000
            : operationName === 'lookup'
              ? 3_000
              : 5_000;
        return {
          id: `scenario/${caseName}/${operationName}`,
          sweep: 'scenario-operations',
          case_name: caseName,
          operation_name: operationName,
          metric,
          limit_ms: limit,
          baseline_p95_ms: BASELINE.scenario_operations[`${caseName}/${operationName}`],
        };
      }),
    ),
  ];
}

function concurrencyBudgets() {
  return PR_SMOKE_CONCURRENCY_MODES.flatMap((mode) =>
    PR_SMOKE_CONCURRENCY_LEVELS.map((concurrency) => {
      const caseName = `submit_${mode}_${concurrency}`;
      return {
        id: `concurrency/${caseName}/batch`,
        sweep: 'concurrency',
        case_name: caseName,
        metric: 'batch_total_ms',
        limit_ms: 5_000,
        baseline_p95_ms: BASELINE.concurrency[caseName],
      };
    }),
  );
}

export const PR_SMOKE_BUDGETS = [
  ...transportBudgets(),
  ...scenarioBudgets(),
  ...concurrencyBudgets(),
];
export const PR_SMOKE_BUDGET_IDS = PR_SMOKE_BUDGETS.map(({ id }) => id);

function identity(value) {
  return [value.sweep, value.case_name, value.transport ?? '-', value.operation_name ?? '-'].join(
    '\u0000',
  );
}

export const PR_SMOKE_AGGREGATE_IDENTITIES = [
  ...PR_SMOKE_CASES.map((benchmarkCase) =>
    identity({ sweep: 'transport', case_name: benchmarkCase.name, transport: 'rust_direct' }),
  ),
  ...PR_SMOKE_CONCURRENCY_OPERATIONS.flatMap((operationKind) =>
    PR_SMOKE_CONCURRENCY_MODES.flatMap((mode) =>
      PR_SMOKE_CONCURRENCY_LEVELS.map((concurrency) =>
        identity({
          sweep: 'concurrency',
          case_name: `${operationKind === 'workflow.signal.submit' ? 'submit' : 'lookup'}_${mode}_${concurrency}`,
        }),
      ),
    ),
  ),
  ...CANONICAL_SCENARIOS.map((caseName) => identity({ sweep: 'scenarios', case_name: caseName })),
  ...CANONICAL_SCENARIOS.flatMap((caseName) =>
    SCENARIO_OPERATION_NAMES[caseName].map((operationName) =>
      identity({
        sweep: 'scenario-operations',
        case_name: caseName,
        operation_name: operationName,
      }),
    ),
  ),
];

function matches(aggregate, budget) {
  return (
    aggregate.sweep === budget.sweep &&
    aggregate.case_name === budget.case_name &&
    (budget.transport === undefined || aggregate.transport === budget.transport) &&
    (budget.operation_name === undefined || aggregate.operation_name === budget.operation_name)
  );
}

function pickFinite(source, names = STAGE_METRICS_MS) {
  return Object.fromEntries(
    names.flatMap((name) => (Number.isFinite(source?.[name]) ? [[name, source[name]]] : [])),
  );
}

function stageAttribution(...sources) {
  return {
    stages_ms: Object.assign({}, ...sources.map((source) => pickFinite(source))),
    stages_us: Object.assign({}, ...sources.map((source) => pickFinite(source, STAGE_METRICS_US))),
  };
}

function scenarioSource(sample, operationName) {
  if (operationName === 'hello') {
    return {
      parent: sample.parent_timings?.find((timing) => timing.operation_kind === 'hello'),
    };
  }
  if (operationName === 'preflight') {
    return {
      parent: sample.parent_timings?.find((timing) => timing.operation_kind === 'preflight'),
    };
  }
  return sample.operations?.find((operation) => operation.name === operationName);
}

function metricValue(sample, budget) {
  if (budget.sweep === 'scenarios') return sample.aizign_end_to_end_ms;
  if (budget.sweep === 'concurrency') return sample.batch_total_ms;
  const source =
    budget.sweep === 'scenario-operations' ? scenarioSource(sample, budget.operation_name) : sample;
  return source?.child?.[budget.metric] ?? source?.parent?.[budget.metric];
}

function rawSamplesForBudget(samples, budget) {
  return samples.filter((sample) => {
    if (sample.sample_phase !== 'warm_repeated') return false;
    if (budget.sweep === 'scenario-operations') {
      return sample.sweep === 'scenarios' && sample.case_name === budget.case_name;
    }
    return (
      sample.sweep === budget.sweep &&
      sample.case_name === budget.case_name &&
      (budget.transport === undefined || sample.transport === budget.transport)
    );
  });
}

function operationAttribution(operation, operationIndex) {
  return {
    operation_index: operationIndex,
    ...(operation.name === undefined ? {} : { name: operation.name }),
    operation_kind: operation.parent?.operation_kind ?? 'unknown',
    outcome: operation.outcome ?? operation.parent?.outcome ?? 'unknown',
    ...(operation.error_code === undefined ? {} : { error_code: operation.error_code }),
    ...(operation.unknown_reason === undefined ? {} : { unknown_reason: operation.unknown_reason }),
    ...stageAttribution(operation.child, operation.parent),
  };
}

function sampleAttribution(sample, measured) {
  const attribution = {
    sample_phase: sample.sample_phase,
    sample_index: sample.sample_index,
    measured_ms: measured,
    ...stageAttribution(),
  };
  if (sample.sweep === 'transport') {
    Object.assign(attribution, stageAttribution(sample.child, sample.parent));
  } else if (sample.sweep === 'concurrency') {
    attribution.stages_ms = pickFinite(sample, ['batch_total_ms']);
    attribution.operations = sample.operations.map(operationAttribution);
  } else {
    attribution.stages_ms = pickFinite(sample, ['aizign_end_to_end_ms']);
    const hello = scenarioSource(sample, 'hello');
    const preflight = scenarioSource(sample, 'preflight');
    attribution.operations = [
      { name: 'hello', ...hello },
      { name: 'preflight', ...preflight },
      ...sample.operations,
    ].map(operationAttribution);
  }
  return attribution;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateContract(config, aggregates, budgets) {
  const errors = [];
  if (
    config.profile !== PR_SMOKE_CONFIG.profile ||
    config.warmup !== PR_SMOKE_CONFIG.warmup ||
    config.samples !== PR_SMOKE_CONFIG.samples ||
    !sameArray(config.sweeps, PR_SMOKE_CONFIG.sweeps)
  ) {
    errors.push('noncanonical_config');
  }
  const budgetIds = budgets.map(({ id }) => id);
  if (new Set(budgetIds).size !== budgetIds.length) errors.push('duplicate_budget_id');
  if (!sameArray([...budgetIds].sort(), [...PR_SMOKE_BUDGET_IDS].sort())) {
    errors.push('budget_identity_mismatch');
  }
  const aggregateIds = aggregates.map(identity);
  if (new Set(aggregateIds).size !== aggregateIds.length) errors.push('duplicate_aggregate');
  if (!sameArray([...aggregateIds].sort(), [...PR_SMOKE_AGGREGATE_IDENTITIES].sort())) {
    errors.push('aggregate_identity_mismatch');
  }
  return errors;
}

function baselineSummary() {
  return {
    manifest: 'benchmarks/performance/native-baseline-v3.json',
    commit_sha: NATIVE_BASELINE_MANIFEST.commit_sha,
    runner_version: NATIVE_BASELINE_MANIFEST.runner_version,
    github_runner_image: NATIVE_BASELINE_MANIFEST.github_runner_image,
    github_runner_image_version: NATIVE_BASELINE_MANIFEST.github_runner_image_version,
    workflow_run_ids: NATIVE_BASELINE_MANIFEST.runs.map(({ workflow_run_id: id }) => id),
    run_count: NATIVE_BASELINE_MANIFEST.runs.length,
    samples_per_point: NATIVE_BASELINE_MANIFEST.samples_per_point,
    artifact_digests: NATIVE_BASELINE_MANIFEST.runs.map(
      ({ workflow_run_id, result_sha256, summary_sha256 }) => ({
        workflow_run_id,
        result_sha256,
        summary_sha256,
      }),
    ),
  };
}

export function evaluatePrSmokeBudgets(
  { config, aggregates, samples },
  budgets = PR_SMOKE_BUDGETS,
) {
  const contractErrors = validateContract(config, aggregates, budgets);
  const evaluations = budgets.map((budget) => {
    const matchingAggregates = aggregates.filter((candidate) => matches(candidate, budget));
    const aggregate = matchingAggregates.length === 1 ? matchingAggregates[0] : undefined;
    const metric = aggregate?.metrics?.[budget.metric];
    const rawSamples = rawSamplesForBudget(samples, budget);
    const measuredSamples = rawSamples
      .map((sample) => ({ sample, measured: metricValue(sample, budget) }))
      .filter(({ measured }) => Number.isFinite(measured));
    const slowest = measuredSamples.sort((left, right) => right.measured - left.measured)[0];
    const measured = slowest?.measured;
    const evaluationErrors = [];
    if (matchingAggregates.length !== 1) evaluationErrors.push('aggregate_count');
    if (metric?.sample_count !== PR_SMOKE_CONFIG.samples)
      evaluationErrors.push('metric_sample_count');
    if (rawSamples.length !== PR_SMOKE_CONFIG.samples) evaluationErrors.push('raw_sample_count');
    if (measuredSamples.length !== PR_SMOKE_CONFIG.samples) {
      evaluationErrors.push('raw_metric_sample_count');
    }
    if (Number.isFinite(measured) && metric?.max !== measured) {
      evaluationErrors.push('aggregate_raw_max_mismatch');
    }
    const status =
      contractErrors.length === 0 &&
      evaluationErrors.length === 0 &&
      Number.isFinite(measured) &&
      measured <= budget.limit_ms
        ? 'pass'
        : 'fail';
    return {
      id: budget.id,
      metric: budget.metric,
      statistic: 'max',
      sample_count: metric?.sample_count ?? 0,
      measured_ms: Number.isFinite(measured) ? measured : null,
      limit_ms: budget.limit_ms,
      baseline_p95_ms: budget.baseline_p95_ms,
      status,
      contract_errors: evaluationErrors,
      sample_attribution:
        slowest === undefined ? null : sampleAttribution(slowest.sample, slowest.measured),
    };
  });
  const failed = evaluations.filter((evaluation) => evaluation.status === 'fail').length;
  return {
    version: PR_SMOKE_BUDGET_VERSION,
    status: failed === 0 && contractErrors.length === 0 ? 'pass' : 'fail',
    passed: evaluations.length - failed,
    failed,
    contract_errors: contractErrors,
    baseline: baselineSummary(),
    evaluations,
  };
}
