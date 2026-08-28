import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONSUMER_PATH = join(ROOT, 'spec/test/package-export-consumer.ts');
const COMPILER_OPTIONS = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ESNext,
  types: [],
};

const surfaces = [
  {
    specifier: '@aizign/protocol',
    manifest: 'packages/protocol/package.json',
    exportKey: '.',
    runtime: [
      'BOOTSTRAP_ENVELOPE_VERSION',
      'CAPABILITY_WORKFLOW_SIGNAL_RECONCILE',
      'CAPABILITY_WORKFLOW_SIGNAL_SUBMIT',
      'DecodeFailure',
      'KIND_HELLO',
      'KIND_WORKFLOW_SIGNAL_RECONCILE',
      'KIND_WORKFLOW_SIGNAL_SUBMIT',
      'MAX_FRAME_BYTES',
      'MAX_REQUEST_BYTES',
      'OneShotFrameCollector',
      'PROTOCOL_NAME',
      'PROTOCOL_VERSION',
      'ProtocolError',
      'checkCompatibility',
      'checkCorrelation',
      'codes',
      'decodeRequest',
      'decodeResponse',
      'decodeWorkflowSignalReconcile',
      'decodeWorkflowSignalSubmit',
      'encodeRequest',
      'encodeResponse',
      'extractFrame',
      'isIdentifier',
      'isShortErrorCode',
    ],
    types: [
      'BoundedFrameExtraction',
      'CallOptions',
      'ContentDigest',
      'CoreClient',
      'CorrelationMismatch',
      'Disposition',
      'ExpectedAssignment',
      'FrameExtraction',
      'HelloInfo',
      'HelloOutcome',
      'Incompatibility',
      'PackageInfo',
      'ReconcileOutcome',
      'ReconcileUnknown',
      'ReconciliationDisposition',
      'ReconciliationResult',
      'Request',
      'Response',
      'ResponseBody',
      'ResponseVersion',
      'Role',
      'SentRequest',
      'SignalKind',
      'SignalResult',
      'SubmitOutcome',
      'UnknownOutcome',
      'WorkflowSignal',
      'WorkflowSignalReconcilePayload',
      'WorkflowSignalSubmitPayload',
    ],
  },
  {
    specifier: '@aizign/adapter-testkit',
    manifest: 'packages/adapter-testkit/package.json',
    exportKey: '.',
    runtime: [
      'assertMetadataOnly',
      'fakeCoreExecutable',
      'readFakeRequests',
      'runCoreClientConformance',
      'runCoreScenarios',
      'samplePayload',
    ],
    types: ['ConformanceOptions', 'CoreClientFactory', 'CoreClientFixtureConfig', 'CoreCommand'],
  },
  {
    specifier: '@aizign/adapter-dsh',
    manifest: 'adapters/dsh/package.json',
    exportKey: '.',
    runtime: ['Config', 'apply', 'inject', 'name'],
    types: ['PluginConfig'],
  },
  {
    specifier: '@aizign/adapter-dsh/experimental/transport',
    manifest: 'adapters/dsh/package.json',
    exportKey: './experimental/transport',
    runtime: ['OneShotCoreClient', 'isTimingErrorCode', 'preflight'],
    types: [
      'OneShotCoreClientConfig',
      'ParentOperationKind',
      'ParentTimingMeasurement',
      'ParentTimingSink',
      'PreflightOptions',
      'TimingOutcome',
      'TimingSink',
    ],
  },
  {
    specifier: '@aizign/adapter-dsh/experimental/evidence',
    manifest: 'adapters/dsh/package.json',
    exportKey: './experimental/evidence',
    runtime: [
      'DEFAULT_COLD_READ_TIMEOUT_MS',
      'DEFAULT_MAX_EVENTS',
      'presentationMetaFor',
      'readSignalEvidence',
    ],
    types: [
      'ColdReadOptions',
      'ColdReadTimingMeasurement',
      'ColdReadTimingSink',
      'ColdReadUnknownReason',
      'EvidenceSource',
      'SessionEventLike',
      'SignalBinding',
      'SignalEvidence',
      'SignalPresentationMeta',
      'SignalResultMeta',
    ],
  },
];

const sourceDependencySurfaces = [
  {
    root: 'packages/protocol/src',
    tsconfig: 'packages/protocol/tsconfig.json',
    allowed: ['@aizign/protocol'],
  },
  {
    root: 'packages/adapter-testkit/src',
    tsconfig: 'packages/adapter-testkit/tsconfig.json',
    allowed: ['@aizign/adapter-testkit', '@aizign/protocol'],
  },
  {
    root: 'adapters/dsh/src',
    tsconfig: 'adapters/dsh/tsconfig.json',
    allowed: ['@aizign/adapter-dsh', '@aizign/protocol'],
  },
  {
    root: 'adapters/dsh/test',
    tsconfig: 'adapters/dsh/tsconfig.json',
    allowed: ['@aizign/adapter-dsh', '@aizign/adapter-testkit', '@aizign/protocol'],
  },
];

const workspacePackagePaths = [
  { name: '@aizign/protocol', root: realpathSync(join(ROOT, 'packages/protocol')) },
  {
    name: '@aizign/adapter-testkit',
    root: realpathSync(join(ROOT, 'packages/adapter-testkit')),
  },
  { name: '@aizign/adapter-dsh', root: realpathSync(join(ROOT, 'adapters/dsh')) },
];

function sorted(values) {
  return [...values].sort();
}

function diagnosticSummary(diagnostics) {
  return diagnostics.map(
    (diagnostic) =>
      `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
  );
}

function manifestTypesTarget(surface) {
  const manifestPath = join(ROOT, surface.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = manifest.exports?.[surface.exportKey];
  assert.equal(
    typeof entry?.types,
    'string',
    `${surface.specifier} must declare an explicit exports types target`,
  );
  return realpathSync(resolve(dirname(manifestPath), entry.types));
}

function resolvedDeclaration(surface) {
  const resolution = ts.resolveModuleName(
    surface.specifier,
    CONSUMER_PATH,
    COMPILER_OPTIONS,
    ts.sys,
  ).resolvedModule;
  assert.ok(resolution, `${surface.specifier} must resolve for a TypeScript consumer`);
  const resolved = realpathSync(resolution.resolvedFileName);
  assert.equal(
    resolved,
    manifestTypesTarget(surface),
    `${surface.specifier} compiler resolution must match its manifest types target`,
  );
  return resolved;
}

function consumerVisibleExports(declaration, specifier) {
  const program = ts.createProgram({ rootNames: [declaration], options: COMPILER_OPTIONS });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnosticSummary(diagnostics), [], `${specifier} declaration diagnostics`);
  const source = program.getSourceFile(declaration);
  assert.ok(source, `${specifier} resolved declaration must be in the TypeScript program`);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  assert.ok(moduleSymbol, `${specifier} resolved declaration must be an external module`);
  return sorted(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName()));
}

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:js|mjs|ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function moduleSpecifiers(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const specifiers = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

function compilerOptionsFromConfig(path) {
  const configPath = join(ROOT, path);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error !== undefined) {
    assert.fail(`${path}: ${diagnosticSummary([loaded.error]).join('; ')}`);
  }
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configPath));
  assert.deepEqual(diagnosticSummary(parsed.errors), [], `${path} diagnostics`);
  return parsed.options;
}

function resolvedWorkspacePackage(specifier, containingFile, compilerOptions) {
  const resolution = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (resolution === undefined) return undefined;
  const resolved = realpathSync(resolution.resolvedFileName);
  return workspacePackagePaths.find(
    (workspacePackage) =>
      resolved === workspacePackage.root || resolved.startsWith(`${workspacePackage.root}${sep}`),
  )?.name;
}

test('compiler-visible export audit expands type-only export stars', () => {
  const temporaryRoot = mkdtempSync(join(ROOT, '.package-export-star-'));
  try {
    const internal = join(temporaryRoot, 'internal.d.ts');
    const entry = join(temporaryRoot, 'entry.d.ts');
    writeFileSync(internal, 'export interface UnexpectedType { readonly value: string }\n');
    writeFileSync(entry, "export type * from './internal.js';\n");
    assert.deepEqual(consumerVisibleExports(entry, 'type-export-star fixture'), ['UnexpectedType']);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('TypeScript package runtime and consumer-visible type exports match exact allowlists', async () => {
  for (const surface of surfaces) {
    const module = await import(surface.specifier);
    assert.deepEqual(sorted(Object.keys(module)), sorted(surface.runtime), surface.specifier);
    const declaration = resolvedDeclaration(surface);
    assert.deepEqual(
      consumerVisibleExports(declaration, surface.specifier),
      sorted([...surface.runtime, ...surface.types]),
      `${surface.specifier} compiler-visible exports`,
    );
  }
});

test('TypeScript package manifests expose only the accepted closed subpaths', () => {
  const expected = new Map([
    ['packages/protocol/package.json', ['.', './package.json']],
    ['packages/adapter-testkit/package.json', ['.', './package.json']],
    [
      'adapters/dsh/package.json',
      ['.', './experimental/evidence', './experimental/transport', './package.json'],
    ],
  ]);
  for (const [path, subpaths] of expected) {
    const manifest = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
    assert.deepEqual(sorted(Object.keys(manifest.exports)), sorted(subpaths), path);
  }
});

test('workspace source imports match the exact package dependency directions', () => {
  for (const surface of sourceDependencySurfaces) {
    const compilerOptions = compilerOptionsFromConfig(surface.tsconfig);
    for (const path of sourceFiles(join(ROOT, surface.root))) {
      for (const specifier of moduleSpecifiers(path)) {
        const packageName = resolvedWorkspacePackage(specifier, path, compilerOptions);
        if (specifier.startsWith('@aizign/')) {
          assert.notEqual(packageName, undefined, `${path} must resolve ${specifier}`);
        }
        if (packageName === undefined) continue;
        assert.ok(
          surface.allowed.includes(packageName),
          `${path} imports ${specifier}; allowed workspace packages are ${surface.allowed.join(', ')}`,
        );
      }
    }
  }
});

test('workspace source audit includes template-literal dynamic imports and import types', () => {
  const temporaryRoot = mkdtempSync(join(ROOT, 'adapters/dsh/.package-import-syntax-'));
  try {
    const path = join(temporaryRoot, 'forbidden.ts');
    writeFileSync(
      path,
      [
        'export async function load() {',
        '  return import(`@aizign/adapter-testkit`);',
        '}',
        "export type LeakedFactory = import('@aizign/adapter-testkit').CoreClientFactory;",
      ].join('\n'),
    );
    const specifiers = moduleSpecifiers(path);
    assert.deepEqual(specifiers, ['@aizign/adapter-testkit', '@aizign/adapter-testkit']);
    const compilerOptions = compilerOptionsFromConfig('adapters/dsh/tsconfig.json');
    assert.deepEqual(
      specifiers.map((specifier) => resolvedWorkspacePackage(specifier, path, compilerOptions)),
      ['@aizign/adapter-testkit', '@aizign/adapter-testkit'],
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('removed and deep package paths cannot bypass the closed export maps', async () => {
  for (const specifier of [
    '@aizign/protocol/src/client.js',
    '@aizign/protocol/lib/index.js',
    '@aizign/adapter-testkit/src/conformance.js',
    '@aizign/adapter-testkit/lib/index.js',
    '@aizign/adapter-dsh/src/core-client/one-shot-client.js',
    '@aizign/adapter-dsh/lib/index.js',
  ]) {
    await assert.rejects(
      import(specifier),
      (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
  }
});

test('TypeScript consumers cannot compile removed symbols or closed package paths', () => {
  const cases = [
    {
      name: 'removed-protocol-config',
      source: "import type { CoreClientConfig } from '@aizign/protocol';\n",
      code: 2305,
    },
    {
      name: 'removed-submit-rejection-classifier',
      source: "import { isSubmitRejectionCode } from '@aizign/protocol';\n",
      code: 2305,
    },
    {
      name: 'removed-unknown-outcome-classifier',
      source: "import { isUnknownOutcomeCode } from '@aizign/protocol';\n",
      code: 2724,
    },
    {
      name: 'removed-submit-rejection-codes',
      source: "import { SUBMIT_REJECTION_CODES } from '@aizign/protocol';\n",
      code: 2305,
    },
    {
      name: 'removed-unknown-outcome-codes',
      source: "import { UNKNOWN_OUTCOME_CODES } from '@aizign/protocol';\n",
      code: 2724,
    },
    {
      name: 'removed-workflow-submit-payload-encoder',
      source: "import { encodeWorkflowSignalSubmit } from '@aizign/protocol';\n",
      code: 2724,
    },
    {
      name: 'removed-workflow-reconcile-payload-encoder',
      source: "import { encodeWorkflowSignalReconcile } from '@aizign/protocol';\n",
      code: 2724,
    },
    {
      name: 'removed-testkit-client',
      source: "import { ReferenceOneShotClient } from '@aizign/adapter-testkit';\n",
      code: 2305,
    },
    {
      name: 'transport-hidden-from-stable-root',
      source: "import { OneShotCoreClient } from '@aizign/adapter-dsh';\n",
      code: 2305,
    },
    {
      name: 'removed-production-child-environment',
      source:
        "import type { OneShotCoreClientConfig } from '@aizign/adapter-dsh/experimental/transport';\nconst config: OneShotCoreClientConfig = { command: '/aizign', stateDir: '/state', timeoutMs: 1, env: { SECRET: 'x' } };\nvoid config;\n",
      code: 2353,
    },
    {
      name: 'trusted-signal-values-are-required',
      source:
        "import type { PluginConfig } from '@aizign/adapter-dsh';\nconst config: PluginConfig = { binary: '/aizign', stateDir: '/state', eventId: 'evt', workflowId: 'wf', assignmentId: 'as', attemptId: 'attempt', role: 'review', artifactRevision: 'rev', candidateDigest: { algorithm: 'sha256', hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } };\nvoid config;\n",
      code: 2741,
    },
    {
      name: 'protocol-deep-path',
      source: "import type { CoreClient } from '@aizign/protocol/src/client.js';\n",
      code: 2307,
    },
    {
      name: 'dsh-deep-path',
      source:
        "import { OneShotCoreClient } from '@aizign/adapter-dsh/src/core-client/one-shot-client.js';\n",
      code: 2307,
    },
    {
      name: 'undeclared-experimental-subpath',
      source: "import type { SignalEvidence } from '@aizign/adapter-dsh/experimental/missing';\n",
      code: 2307,
    },
  ];
  const temporaryRoot = mkdtempSync(join(ROOT, '.package-export-consumer-'));
  try {
    for (const fixture of cases) {
      const sourcePath = join(temporaryRoot, `${fixture.name}.ts`);
      writeFileSync(sourcePath, fixture.source);
      const program = ts.createProgram({ rootNames: [sourcePath], options: COMPILER_OPTIONS });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      assert.ok(
        diagnostics.some((diagnostic) => diagnostic.code === fixture.code),
        `${fixture.name} must fail with TS${fixture.code}; got ${diagnosticSummary(diagnostics).join('; ')}`,
      );
    }
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
