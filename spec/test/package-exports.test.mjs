import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const surfaces = [
  {
    specifier: '@aizign/protocol',
    declaration: 'packages/protocol/lib/index.d.ts',
    runtime: [
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
      'SUBMIT_REJECTION_CODES',
      'UNKNOWN_OUTCOME_CODES',
      'checkCompatibility',
      'checkCorrelation',
      'codes',
      'decodeRequest',
      'decodeResponse',
      'decodeWorkflowSignalReconcile',
      'decodeWorkflowSignalSubmit',
      'encodeRequest',
      'encodeResponse',
      'encodeWorkflowSignalReconcile',
      'encodeWorkflowSignalSubmit',
      'extractFrame',
      'isIdentifier',
      'isShortErrorCode',
      'isSubmitRejectionCode',
      'isUnknownOutcomeCode',
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
    declaration: 'packages/adapter-testkit/lib/index.d.ts',
    runtime: [
      'assertMetadataOnly',
      'fakeCoreCommand',
      'readFakeRequests',
      'runCoreClientConformance',
      'runCoreScenarios',
      'samplePayload',
    ],
    types: ['ConformanceOptions', 'CoreClientFactory', 'CoreClientFixtureConfig', 'CoreCommand'],
  },
  {
    specifier: '@aizign/adapter-dsh',
    declaration: 'adapters/dsh/lib/index.d.ts',
    runtime: ['Config', 'apply', 'inject', 'name'],
    types: ['PluginConfig'],
  },
  {
    specifier: '@aizign/adapter-dsh/experimental/transport',
    declaration: 'adapters/dsh/lib/experimental/transport.d.ts',
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
    declaration: 'adapters/dsh/lib/experimental/evidence.d.ts',
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

function sorted(values) {
  return [...values].sort();
}

function declarationExports(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(join(ROOT, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const runtime = new Set();
  const types = new Set();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        (statement.isTypeOnly || element.isTypeOnly ? types : runtime).add(element.name.text);
      }
      continue;
    }
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) runtime.add(declaration.name.text);
      }
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) runtime.add(statement.name.text);
    } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      types.add(statement.name.text);
    }
  }
  return { runtime: sorted(runtime), types: sorted(types) };
}

test('TypeScript package runtime and declaration exports match exact allowlists', async () => {
  for (const surface of surfaces) {
    const module = await import(surface.specifier);
    assert.deepEqual(sorted(Object.keys(module)), sorted(surface.runtime), surface.specifier);
    const declarations = declarationExports(surface.declaration);
    assert.deepEqual(
      declarations.runtime,
      sorted(surface.runtime),
      `${surface.specifier} runtime d.ts`,
    );
    assert.deepEqual(declarations.types, sorted(surface.types), `${surface.specifier} type d.ts`);
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
