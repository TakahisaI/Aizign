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

const bundles = profile.dsh?.profile?.bundles;
assert(Array.isArray(bundles), "temporary profile has no dsh.profile.bundles list");
assert(bundles.includes("@aizign/adapter-dsh"), "temporary profile bundle list omits @aizign/adapter-dsh");
assert(bundles.includes("@deepseek-ai/dsh-web-app"), "temporary profile bundle list omits @deepseek-ai/dsh-web-app");

try {
  await import("@aizign/protocol");
  await import("@aizign/adapter-dsh");
  const profileRequire = createRequire(pathToFileURL(resolve(profileDir, "package.json")));
  profileRequire("@aizign/adapter-dsh");
} catch (error) {
  fail(`workspace package import failed: ${error.message}`);
}

console.log("source-workspace: temporary DSH registration and workspace links verified");
