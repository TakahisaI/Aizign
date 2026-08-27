import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

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

console.log("source-workspace: temporary DSH registration and workspace links verified");
