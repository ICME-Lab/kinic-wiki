import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const installScript = join(repoRoot, "mobile", "ios", "scripts", "install-device.sh");
const testFlightScript = join(repoRoot, "mobile", "ios", "scripts", "testflight-upload.sh");
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
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  for (const setting of required) {
    assert.match(result.stdout, new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

const testFlight = spawnSync(
  "bash",
  [testFlightScript, "--sandbox", "--print-runtime-config"],
  { cwd: repoRoot, encoding: "utf8" }
);
assert.match(testFlight.stdout, /distribution=internal-only/);

const external = spawnSync(
  "bash",
  [testFlightScript, "--sandbox", "--external", "--print-runtime-config"],
  { cwd: repoRoot, encoding: "utf8" }
);
assert.notEqual(external.status, 0);
assert.match(external.stderr, /cannot be uploaded for external TestFlight distribution/);

console.log("iOS Sandbox runtime wrappers OK");
