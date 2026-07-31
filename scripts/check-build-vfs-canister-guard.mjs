// Where: scripts/check-build-vfs-canister-guard.mjs
// What: Verify production builds reject local Internet Identity origins.
// Why: A compile-time local II origin flag must not leak into mainnet artifacts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts", "build-vfs-canister.sh");

assert.equal(run({ KINIC_VFS_LOCAL_II_ORIGINS: "1", ICP_ENVIRONMENT: "ic" }).status, 1);
assert.match(
  run({ KINIC_VFS_LOCAL_II_ORIGINS: "1", ICP_ENVIRONMENT: "ic" }).stderr,
  /only allowed for ICP_ENVIRONMENT=local-wiki/
);
assert.equal(run({ KINIC_VFS_LOCAL_II_ORIGINS: "1", ICP_ENVIRONMENT: "local" }).status, 1);
assert.equal(run({ KINIC_VFS_LOCAL_II_ORIGINS: "1", ICP_ENVIRONMENT: "local-wiki" }).status, 0);
assert.equal(run({ KINIC_VFS_LOCAL_II_ORIGINS: "1" }).status, 1);
assert.equal(
  run({
    KINIC_VFS_STAGING_II_ORIGIN: "https://kinic-wiki-browser-staging.example.workers.dev",
    ICP_ENVIRONMENT: "staging"
  }).status,
  0
);
assert.match(
  run({
    KINIC_VFS_STAGING_II_ORIGIN: "https://kinic-wiki-browser-staging.example.workers.dev",
    ICP_ENVIRONMENT: "mainnet-sev"
  }).stderr,
  /only allowed for ICP_ENVIRONMENT=staging/
);
assert.match(
  run({
    KINIC_VFS_STAGING_II_ORIGIN: "http://kinic-wiki-browser-staging.example.workers.dev",
    ICP_ENVIRONMENT: "staging"
  }).stderr,
  /must be an HTTPS origin without a path/
);
assert.match(
  run({ ICP_ENVIRONMENT: "staging" }).stderr,
  /KINIC_VFS_STAGING_II_ORIGIN is required/
);
assert.equal(run({}).status, 0);

console.log("Build VFS canister guard OK");

function run(env) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.KINIC_VFS_LOCAL_II_ORIGINS;
  delete cleanEnv.KINIC_VFS_STAGING_II_ORIGIN;
  delete cleanEnv.ICP_ENVIRONMENT;
  return spawnSync("bash", [script, "--check-env-only"], {
    cwd: root,
    env: { ...cleanEnv, ...env },
    encoding: "utf8"
  });
}
