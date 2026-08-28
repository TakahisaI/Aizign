import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { inspect } from "node:util";

const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const profileDir = process.env.DSH_PROFILE_DIR;

function fail(message) {
  console.error(`source-workspace check failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function real(path, label) {
  try {
    return realpathSync(path);
  } catch (error) {
    fail(`${label} is not present: ${path} (${error.message})`);
  }
}

assert(profileDir !== undefined && profileDir !== "", "DSH_PROFILE_DIR is required");
const configPath = process.env.DSH_CONFIG_PATH;
const expectedBinary = process.env.DSH_EXPECTED_BINARY;
const expectedStateDir = process.env.DSH_EXPECTED_STATE_DIR;
assert(configPath !== undefined && configPath !== "", "DSH_CONFIG_PATH is required");
assert(expectedBinary !== undefined && expectedBinary !== "", "DSH_EXPECTED_BINARY is required");
assert(
  expectedStateDir !== undefined && expectedStateDir !== "",
  "DSH_EXPECTED_STATE_DIR is required"
);

let profile;
try {
  profile = JSON.parse(readFileSync(resolve(profileDir, "package.json"), "utf8"));
} catch (error) {
  fail(`temporary DSH profile package.json could not be read: ${error.message}`);
}

const expectedProtocol = resolve(root, "packages/protocol");
const expectedAdapter = resolve(root, "adapters/dsh");
const profileAdapter = real(
  resolve(profileDir, "node_modules/@aizign/adapter-dsh"),
  "profile adapter link"
);
const workspaceAdapter = real(
  resolve(root, "node_modules/@aizign/adapter-dsh"),
  "workspace adapter link"
);
const workspaceProtocol = real(
  resolve(root, "node_modules/@aizign/protocol"),
  "workspace protocol link"
);

assert(profileAdapter === expectedAdapter, `profile adapter resolves to ${profileAdapter}, expected ${expectedAdapter}`);
assert(workspaceAdapter === expectedAdapter, `workspace adapter resolves to ${workspaceAdapter}, expected ${expectedAdapter}`);
assert(workspaceProtocol === expectedProtocol, `workspace protocol resolves to ${workspaceProtocol}, expected ${expectedProtocol}`);

const adapterSpec = profile.dependencies?.["@aizign/adapter-dsh"];
assert(
  adapterSpec === `link:${expectedAdapter}`,
  `profile adapter dependency is ${JSON.stringify(adapterSpec)}, expected link:${expectedAdapter}`
);

let profileLock;
try {
  profileLock = readFileSync(resolve(profileDir, "pnpm-lock.yaml"), "utf8");
} catch (error) {
  fail(`temporary DSH profile pnpm-lock.yaml could not be read: ${error.message}`);
}
const lockAizignNames = [
  ...profileLock.matchAll(/@aizign\/[A-Za-z0-9._-]+/g),
].map((match) => match[0]);
const unexpectedLockNames = [...new Set(lockAizignNames)].filter(
  (name) => name !== "@aizign/adapter-dsh"
);
assert(
  unexpectedLockNames.length === 0,
  `temporary DSH profile lockfile resolves unexpected Aizign packages: ${unexpectedLockNames.join(", ")}`
);
assert(
  profileLock.includes(`specifier: ${adapterSpec}`),
  "temporary DSH profile lockfile does not retain the absolute adapter link"
);

const bundles = profile.dsh?.profile?.bundles;
assert(Array.isArray(bundles), "temporary profile has no dsh.profile.bundles list");
assert(bundles.includes("@aizign/adapter-dsh"), "temporary profile bundle list omits @aizign/adapter-dsh");
assert(bundles.includes("@deepseek-ai/dsh-web-app"), "temporary profile bundle list omits @deepseek-ai/dsh-web-app");

const profileRequire = createRequire(pathToFileURL(resolve(profileDir, "package.json")));
let profileAdapterManifest;
try {
  profileAdapterManifest = profileRequire.resolve("@aizign/adapter-dsh/package.json");
  const profileAdapterRequire = createRequire(pathToFileURL(profileAdapterManifest));
  const profileProtocolManifest = real(
    profileAdapterRequire.resolve("@aizign/protocol/package.json"),
    "profile adapter protocol dependency"
  );
  const expectedProtocolManifest = real(
    resolve(expectedProtocol, "package.json"),
    "workspace protocol package manifest"
  );
  assert(
    profileProtocolManifest === expectedProtocolManifest,
    `profile adapter protocol resolves to ${profileProtocolManifest}, expected ${expectedProtocolManifest}`
  );
} catch (error) {
  fail(`profile package resolution failed: ${error.message}`);
}

try {
  await import("@aizign/protocol");
  await import("@aizign/adapter-dsh");
  for (const specifier of [
    "@aizign/adapter-dsh",
    "@aizign/adapter-dsh/experimental/transport",
    "@aizign/adapter-dsh/experimental/evidence",
  ]) {
    profileRequire.resolve(specifier);
    profileRequire(specifier);
  }
} catch (error) {
  fail(`workspace or profile package import failed: ${error.message}`);
}

function extractConfigEntry(text, id) {
  const start = text.indexOf(`- id: ${id}`);
  assert(start >= 0, `composed DSH config omits ${id}`);
  const entry = text.slice(start);
  const nextEntry = entry.search(/\n- id: /);
  return nextEntry === -1 ? entry : entry.slice(0, nextEntry);
}

function configScalar(entry, key, indent = 4) {
  const match = entry.match(new RegExp(`^${" ".repeat(indent)}${key}:\\s*(.+)$`, "m"));
  assert(match !== null, `composed DSH config omits ${key}`);
  const value = match[1].trim();
  if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
    return value.slice(1, -1);
  }
  return value;
}

let configText;
try {
  configText = readFileSync(configPath, "utf8");
} catch (error) {
  fail(`composed DSH config could not be read: ${error.message}`);
}
const configEntry = extractConfigEntry(configText, "aizign-workflow-signal");
assert(
  /^  name:\s+['"]@aizign\/adapter-dsh['"]\s*$/m.test(configEntry),
  "composed DSH config entry has the wrong plugin name"
);
assert(/^  disabled:\s+false\s*$/m.test(configEntry), "composed DSH config entry is not active");
assert(/^  config:\s*$/m.test(configEntry), "composed DSH config entry has no configuration");
assert(
  configScalar(configEntry, "binary") === expectedBinary,
  `composed DSH config binary does not match ${expectedBinary}`
);
assert(
  configScalar(configEntry, "stateDir") === expectedStateDir,
  `composed DSH config stateDir does not match ${expectedStateDir}`
);
const timeoutMs = Number(configScalar(configEntry, "timeoutMs"));
assert(Number.isInteger(timeoutMs) && timeoutMs > 0, "composed DSH config timeoutMs is invalid");
for (const key of [
  "eventId",
  "workflowId",
  "assignmentId",
  "attemptId",
  "artifactRevision",
]) {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configScalar(configEntry, key)),
    `composed DSH config ${key} is invalid`
  );
}
assert(
  ["implementation", "review"].includes(configScalar(configEntry, "role")),
  "composed DSH config role is invalid"
);
assert(
  configScalar(configEntry, "algorithm", 6) === "sha256",
  "composed DSH config digest algorithm is invalid"
);
assert(
  /^[0-9a-f]{64}$/.test(configScalar(configEntry, "hex", 6)),
  "composed DSH config digest hex is invalid"
);
assert(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(configScalar(configEntry, "artifactRef", 6)),
  "composed DSH config trusted artifactRef is invalid"
);
assert(
  /^[A-Z][A-Z0-9_]{0,63}$/.test(configScalar(configEntry, "blockedShortErrorCode", 6)),
  "composed DSH config trusted blockedShortErrorCode is invalid"
);

console.log("source-workspace: temporary DSH registration and workspace links verified");

// Execute one malformed profile through the real pinned App Boot + Loader
// stack. Rendered text is insufficient evidence: inspect the actual cause
// objects so wrapper order, entry identity, inner code/message, and the absent
// inner cause are all fixed at this exact host boundary (ADR-0026).
const fakeToolsPath = resolve(profileDir, "aizign-ci-tools.mjs");
const registrationMarker = resolve(profileDir, "aizign-invalid-registration.marker");
const invocationMarker = resolve(profileDir, "aizign-invalid-invocation.marker");
const fakeBinaryPath = resolve(profileDir, "aizign-invalid-binary.mjs");
writeFileSync(
  fakeToolsPath,
  `import { appendFileSync } from "node:fs";\nexport function apply(ctx) {\n  ctx.provide("tools", { register() { appendFileSync(${JSON.stringify(registrationMarker)}, "registered\\n"); return () => undefined; } });\n}\n`,
);
writeFileSync(
  fakeBinaryPath,
  `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(invocationMarker)}, "invoked\\n");\n`,
);
chmodSync(fakeBinaryPath, 0o755);

const invalidCases = [
  {
    id: "malformed",
    canaries: ["credential-synthetic-user-password-private-canary-lowercase"],
    trustedLines: [
      '      artifactRef: "artifact:loader-boundary"',
      '      blockedShortErrorCode: "credential-synthetic-user-password-private-canary-lowercase"',
    ],
  },
  {
    id: "missing",
    canaries: ["artifact:missing-required-member-canary"],
    trustedLines: ['      artifactRef: "artifact:missing-required-member-canary"'],
  },
  {
    id: "unknown",
    canaries: ["ZW5jb2RlZC1wcml2YXRlLWNhbmFyeQ=="],
    trustedLines: [
      '      artifactRef: "artifact:loader-boundary"',
      '      blockedShortErrorCode: "BLOCKED_BY_CONTROL_PLANE"',
      '      unknownMember: "ZW5jb2RlZC1wcml2YXRlLWNhbmFyeQ=="',
    ],
  },
  {
    id: "role-incompatible",
    canaries: ["ROLE_INCOMPATIBLE_PRIVATE_CANARY"],
    trustedLines: ['      blockedShortErrorCode: "ROLE_INCOMPATIBLE_PRIVATE_CANARY"'],
  },
];

function snapshotOwnData(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    const label = typeof key === "symbol" ? key.toString() : key;
    snapshot[label] = descriptor && "value" in descriptor
      ? snapshotOwnData(descriptor.value, seen)
      : "[Accessor]";
  }
  return snapshot;
}

function assertErrorGraph(error, canaries) {
  const chain = [];
  for (let current = error; current !== undefined; current = current.cause) {
    assert(current instanceof Error, "error graph contains a non-Error cause");
    chain.push(current);
  }
  assert(chain.length === 4, `unexpected error chain length: ${chain.length}`);
  const rendered = [
    ...chain.flatMap((entry) => [entry.message, entry.stack ?? ""]),
    inspect(error, { depth: Infinity, showHidden: true, getters: false, customInspect: false }),
    JSON.stringify(snapshotOwnData(error)),
  ].join("\n");
  for (const canary of canaries) {
    assert(!rendered.includes(canary), `rejected config canary leaked: ${canary}`);
  }
  return chain;
}

try {
  const webAppManifest = profileRequire.resolve("@deepseek-ai/dsh-web-app/package.json");
  const webAppRequire = createRequire(pathToFileURL(webAppManifest));
  const appBootManifest = webAppRequire.resolve("@deepseek-ai/dsh-app-boot/package.json");
  const appBootRequire = createRequire(pathToFileURL(appBootManifest));
  const appBootPackage = appBootRequire("@deepseek-ai/dsh-app-boot/package.json");
  const loaderPackage = appBootRequire("@deepseek-ai/cordis-plugin-loader/package.json");
  assert(appBootPackage.version === "0.1.1-rc.2", "unexpected dsh-app-boot version");
  assert(loaderPackage.version === "1.0.2", "unexpected cordis-plugin-loader version");
  const { boot } = await import(
    pathToFileURL(appBootRequire.resolve("@deepseek-ai/dsh-app-boot")).href
  );
  const adapterRequire = createRequire(pathToFileURL(profileAdapterManifest));
  const { HarnessError } = await import(
    pathToFileURL(adapterRequire.resolve("@deepseek-ai/dsh-llm")).href
  );

  for (const invalidCase of invalidCases) {
    const invalidConfigPath = resolve(
      profileDir,
      `aizign-invalid-${invalidCase.id}.cordis.yml`,
    );
    const stateDir = resolve(profileDir, `aizign-invalid-${invalidCase.id}-state`);
    writeFileSync(
      invalidConfigPath,
      `- id: aizign-ci-tools\n  name: ./aizign-ci-tools.mjs\n- id: aizign-workflow-signal\n  name: "@aizign/adapter-dsh"\n  config:\n    binary: ${JSON.stringify(fakeBinaryPath)}\n    stateDir: ${JSON.stringify(stateDir)}\n    timeoutMs: 15000\n    eventId: "evt-loader-boundary"\n    workflowId: "wf-loader-boundary"\n    assignmentId: "as-loader-boundary"\n    attemptId: "attempt-loader-boundary"\n    role: implementation\n    artifactRevision: "rev-loader-boundary"\n    candidateDigest:\n      algorithm: sha256\n      hex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n    trustedSignalValues:\n${invalidCase.trustedLines.join("\n")}\n`,
    );

    let outer;
    try {
      const context = await boot("dsh", invalidConfigPath, []);
      await context.fiber.dispose();
      fail(`invalid trusted configuration unexpectedly booted: ${invalidCase.id}`);
    } catch (error) {
      outer = error;
    }

    const [appBoot, include, adapter, inner] = assertErrorGraph(outer, invalidCase.canaries);
    for (const [label, error] of [
      ["app boot", appBoot],
      ["include entry", include],
      ["adapter entry", adapter],
    ]) {
      assert(error.constructor === Error, `${label} is not a plain Error`);
    }
    assert(
      appBoot.message.startsWith("dsh: plugin tree failed to load:"),
      `unexpected app boot wrapper: ${appBoot.message}`,
    );
    assert(
      include.message.startsWith("failed to apply loader entry include (cordis:include):"),
      `unexpected include wrapper: ${include.message}`,
    );
    assert(
      adapter.message.startsWith(
        "failed to apply loader entry aizign-workflow-signal (@aizign/adapter-dsh):",
      ),
      `unexpected adapter wrapper: ${adapter.message}`,
    );
    assert(inner instanceof HarnessError, "inner failure is not the adapter HarnessError");
    assert(inner.code === "INVALID_EXPECTATION", `unexpected inner code: ${inner.code}`);
    assert(
      inner.message === "Aizign rejected invalid trusted signal configuration",
      `unexpected inner message: ${inner.message}`,
    );
    assert(inner.cause === undefined && !Object.hasOwn(inner, "cause"), "inner error has a cause");
    assert(!existsSync(registrationMarker), "invalid config registered a tool");
    assert(!existsSync(invocationMarker), "invalid config spawned the core process");
    assert(!existsSync(stateDir), "invalid config created a state artifact");
    rmSync(invalidConfigPath, { force: true });
  }
} finally {
  rmSync(fakeToolsPath, { force: true });
  rmSync(fakeBinaryPath, { force: true });
  rmSync(registrationMarker, { force: true });
  rmSync(invocationMarker, { force: true });
}

console.log("source-workspace: pinned DSH startup error wrapper chain verified");
