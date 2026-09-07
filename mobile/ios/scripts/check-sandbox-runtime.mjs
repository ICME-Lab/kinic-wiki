import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const installScript = join(repoRoot, "mobile", "ios", "scripts", "install-device.sh");
const testFlightScript = join(repoRoot, "mobile", "ios", "scripts", "testflight-upload.sh");
const productModel = join(repoRoot, "mobile", "ios", "KinicApp", "Models", "DatabaseCreditProduct.swift");
const sandboxWorkerConfig = join(repoRoot, "workers", "payment", "wrangler.sandbox.jsonc");
const projectSpec = join(repoRoot, "mobile", "ios", "project.yml");
const projectMarketingVersion = readFileSync(projectSpec, "utf8").match(/^\s*MARKETING_VERSION:\s*"([^"]+)"\s*$/mu)?.[1];
assert.ok(projectMarketingVersion, "project MARKETING_VERSION is missing");
const testFlightEnv = { ...process.env, KINIC_IOS_MARKETING_VERSION: projectMarketingVersion };
const required = [
  "KINIC_DEPLOYMENT_ENVIRONMENT=sandbox",
  "KINIC_CANISTER_ID=3ryrw-kyaaa-aaaaf-qgxpq-cai",
  "KINIC_AUTH_ORIGIN=https://kinic-wiki-browser-staging.hude.workers.dev",
  "KINIC_PAYMENT_BASE_URL=https://kinic-payment-sandbox.hude.workers.dev",
  "KINIC_IAP_PRODUCT_IDS=xyz.kinic.dbcredits.small"
];

for (const script of [installScript, testFlightScript]) {
  const result = spawnSync("bash", [script, "--sandbox", "--print-runtime-config"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: script === testFlightScript ? testFlightEnv : process.env
  });
  assert.equal(result.status, 0, result.stderr);
  for (const setting of required) {
    assert.match(result.stdout, new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

const testFlight = spawnSync(
  "bash",
  [testFlightScript, "--sandbox", "--print-runtime-config"],
  { cwd: repoRoot, encoding: "utf8", env: testFlightEnv }
);
assert.match(testFlight.stdout, /distribution=internal-only/);
assert.match(testFlight.stdout, new RegExp(`marketing_version=${projectMarketingVersion}`));

const external = spawnSync(
  "bash",
  [testFlightScript, "--sandbox", "--external", "--print-runtime-config"],
  { cwd: repoRoot, encoding: "utf8", env: testFlightEnv }
);
assert.notEqual(external.status, 0);
assert.match(external.stderr, /cannot be uploaded for external TestFlight distribution/);

const staleEnvDirectory = mkdtempSync(join(tmpdir(), "kinic-testflight-env-"));
try {
  const staleEnvFile = join(staleEnvDirectory, "testflight.env");
  writeFileSync(staleEnvFile, "KINIC_IOS_MARKETING_VERSION=1.0.2\n");
  const staleEnv = { ...process.env, KINIC_IOS_ENV_FILE: staleEnvFile };
  delete staleEnv.KINIC_IOS_MARKETING_VERSION;
  const staleVersion = spawnSync(
    "bash",
    [testFlightScript, "--print-runtime-config"],
    { cwd: repoRoot, encoding: "utf8", env: staleEnv }
  );
  assert.notEqual(staleVersion.status, 0);
  assert.match(staleVersion.stderr, /does not match project\.yml/);
} finally {
  rmSync(staleEnvDirectory, { recursive: true, force: true });
}

const productSource = readFileSync(productModel, "utf8");
const displayAmountMatch = productSource.match(/smallDisplayAmountCycles: UInt64 = ([\d_]+)/);
assert.ok(displayAmountMatch, "small iOS display amount is missing");
const displayAmountCycles = displayAmountMatch[1].replaceAll("_", "");
const workerConfig = JSON.parse(readFileSync(sandboxWorkerConfig, "utf8"));
const workerCatalog = JSON.parse(workerConfig.vars.IAP_PRODUCT_CATALOG_JSON);
assert.equal(
  workerCatalog["xyz.kinic.dbcredits.small"],
  displayAmountCycles,
  "small iOS display amount must match the Sandbox Worker grant"
);

console.log("iOS Sandbox runtime wrappers and product presentation OK");
