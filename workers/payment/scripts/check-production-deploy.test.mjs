import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateProductionConfig } from "./check-production-deploy.mjs";

const paymentRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const example = JSON.parse(readFileSync(join(paymentRoot, "wrangler.production.jsonc.example"), "utf8"));

test("production example has the release environment and one approved product shape", () => {
  validateProductionConfig(example);
});

test("production deployment rejects unprovisioned resource identifiers", () => {
  assert.throws(() => validateProductionConfig(example, { requireProvisioned: true }), /not provisioned/);
});

test("production deployment permits a temporary bounded Sandbox review window", () => {
  const reviewConfig = structuredClone(example);
  reviewConfig.vars.APP_STORE_SANDBOX_FULFILLMENT_ENABLED = "true";
  validateProductionConfig(reviewConfig);
});

test("production deployment rejects an unbounded Sandbox policy", () => {
  const unbounded = structuredClone(example);
  unbounded.vars.APP_STORE_SANDBOX_GRANT_LIMIT = "1000";
  assert.throws(() => validateProductionConfig(unbounded));
});
