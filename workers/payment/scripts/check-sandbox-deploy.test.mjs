import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSandboxConfig } from "./check-sandbox-deploy.mjs";

const paymentRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(paymentRoot, "wrangler.sandbox.jsonc"), "utf8"));

test("accepts the isolated sandbox configuration before provisioning", () => {
  validateSandboxConfig(config);
});

test("rejects a production canister or custom route", () => {
  const productionTarget = structuredClone(config);
  productionTarget.vars.KINIC_WIKI_CANISTER_ID = "6emaw-iyaaa-aaaay-aacka-cai";
  assert.throws(() => validateSandboxConfig(productionTarget));

  const routed = structuredClone(config);
  routed.routes = [{ pattern: "payment.kinic.xyz", custom_domain: true }];
  assert.throws(() => validateSandboxConfig(routed), /must not define routes/);
});

test("requires a provisioned D1 for deployment", () => {
  const unprovisioned = structuredClone(config);
  delete unprovisioned.d1_databases[0].database_id;
  assert.throws(
    () => validateSandboxConfig(unprovisioned, { requireProvisioned: true }),
    /database_id has not been provisioned/
  );
});
