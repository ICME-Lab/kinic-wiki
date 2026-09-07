import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const paymentRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(paymentRoot, "..", "..");
const productId = "xyz.kinic.dbcredits.small";

export function validateProductionConfig(config, { requireProvisioned = false } = {}) {
  assert.equal(config.name, "kinic-payment");
  assert.equal(config.workers_dev ?? false, false);
  assert.deepEqual(config.routes, [{ pattern: "payment.kinic.xyz", custom_domain: true }]);
  assert.equal(config.vars.KINIC_WIKI_CANISTER_ID, "6emaw-iyaaa-aaaay-aacka-cai");
  assert.equal(config.vars.KINIC_WIKI_IC_HOST, "https://icp0.io");
  assert.ok(String(config.vars.KINIC_IAP_AUTHORITY_ID ?? "").trim(), "production IAP authority principal is required");
  assert.equal(config.vars.APP_STORE_ALLOWED_ENVIRONMENTS, "Sandbox,Production");
  assert.ok(
    config.vars.APP_STORE_SANDBOX_FULFILLMENT_ENABLED === "true" || config.vars.APP_STORE_SANDBOX_FULFILLMENT_ENABLED === "false",
    "production Sandbox fulfillment flag must be true or false"
  );
  assert.equal(config.vars.APP_STORE_SANDBOX_GRANT_LIMIT, "10");
  assert.equal(config.vars.APP_STORE_BUNDLE_ID, "xyz.kinic.ios.KinicWiki");
  assertAppleRootFingerprints(config.vars.APP_STORE_NOTIFICATION_ROOT_SHA256S);
  assert.deepEqual(JSON.parse(config.vars.IAP_PRODUCT_CATALOG_JSON), { [productId]: "2000000000000" });

  assert.equal(config.d1_databases?.length, 1);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].database_name, "kinic-payment");
  const rateLimitBindings = config.ratelimits ?? [];
  assert.deepEqual(rateLimitBindings.map((binding) => binding.name), [
    "IAP_GLOBAL_RATE_LIMITER",
    "IAP_PRINCIPAL_RATE_LIMITER"
  ]);

  if (requireProvisioned) {
    assert.match(
      config.vars.KINIC_IAP_AUTHORITY_ID ?? "",
      /^[a-z0-9]+(?:-[a-z0-9]+)+$/u,
      "production IAP authority principal is not provisioned"
    );
    assertUuid(config.d1_databases[0].database_id, "production D1 database_id");
    for (const binding of rateLimitBindings) {
      assert.ok(!String(binding.namespace_id).startsWith("REPLACE_WITH_"), `${binding.name} namespace_id is not provisioned`);
      assert.match(String(binding.namespace_id), /^\d+$/u, `${binding.name} namespace_id must be numeric`);
    }
  }
}

function assertAppleRootFingerprints(value) {
  const fingerprints = String(value ?? "").split(",");
  assert.equal(fingerprints.length, 3, "all three published Apple root fingerprints are required");
  for (const fingerprint of fingerprints) {
    assert.match(fingerprint, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u, "Apple root fingerprint must be SHA-256");
  }
}

function assertUuid(value, label) {
  assert.match(
    String(value ?? ""),
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
    `${label} is not provisioned`
  );
}

function assertProductionSecrets() {
  const result = spawnSync(
    "wrangler",
    ["secret", "list", "--config", "wrangler.production.jsonc", "--format", "json"],
    { cwd: paymentRoot, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  const names = new Set(JSON.parse(result.stdout).map((secret) => secret.name));
  for (const required of [
    "KINIC_IAP_AUTHORITY_IDENTITY_PEM",
    "APP_STORE_ISSUER_ID",
    "APP_STORE_KEY_ID",
    "APP_STORE_PRIVATE_KEY_PEM"
  ]) {
    assert.ok(names.has(required), `missing production Worker secret: ${required}`);
  }
}

function assertGitReady() {
  const conflicts = spawnSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(conflicts.status, 0, conflicts.stderr);
  assert.equal(conflicts.stdout.trim(), "", "production deploy requires no unresolved conflicts");

  const status = spawnSync("git", ["status", "--short"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.trim(), "", "production deploy requires a clean worktree");

  const fetch = spawnSync("git", ["fetch", "origin", "main"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(fetch.status, 0, fetch.stderr);
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(ancestor.status, 0, "HEAD must contain origin/main before production deploy");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configOnly = process.argv.includes("--config-only");
  const example = process.argv.includes("--example");
  const filename = example ? "wrangler.production.jsonc.example" : "wrangler.production.jsonc";
  const config = JSON.parse(readFileSync(join(paymentRoot, filename), "utf8"));
  validateProductionConfig(config, { requireProvisioned: !configOnly && !example });
  if (!configOnly && !example) {
    assertProductionSecrets();
    assertGitReady();
  }
  console.log(`Production deploy guard OK (${example ? "example" : configOnly ? "configuration" : "deployment"})`);
}
