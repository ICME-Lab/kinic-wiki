import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const paymentRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(paymentRoot, "..", "..");

export function validateSandboxConfig(config, { requireProvisioned = false } = {}) {
  assert.equal(config.name, "kinic-payment-sandbox");
  assert.equal(config.workers_dev, true);
  assert.ok(!config.routes?.length, "sandbox config must not define routes");
  assert.equal(config.vars.KINIC_WIKI_CANISTER_ID, "3ryrw-kyaaa-aaaaf-qgxpq-cai");
  assert.equal(config.vars.APP_STORE_ENVIRONMENT, "Sandbox");
  assert.equal(config.vars.APP_STORE_BUNDLE_ID, "xyz.kinic.ios.KinicWiki");

  const catalog = JSON.parse(config.vars.IAP_PRODUCT_CATALOG_JSON);
  assert.deepEqual(Object.keys(catalog), ["xyz.kinic.dbcredits.small"]);

  assert.equal(config.d1_databases?.length, 1);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].database_name, "kinic-payment-sandbox");

  const namespaces = config.ratelimits?.map((binding) => binding.namespace_id) ?? [];
  assert.deepEqual(namespaces, ["21001", "21002"]);
  assert.equal(new Set(namespaces).size, namespaces.length);

  if (requireProvisioned) {
    assert.match(
      config.vars.KINIC_IAP_AUTHORITY_ID ?? "",
      /^[a-z0-9]+(?:-[a-z0-9]+)+$/,
      "sandbox IAP authority principal has not been recorded"
    );
    assert.match(
      config.d1_databases[0].database_id ?? "",
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
      "sandbox D1 database_id has not been provisioned"
    );
  }
}

function assertSandboxSecrets() {
  const result = spawnSync(
    "wrangler",
    ["secret", "list", "--config", "wrangler.sandbox.jsonc", "--format", "json"],
    { cwd: paymentRoot, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  const names = new Set(JSON.parse(result.stdout).map((secret) => secret.name));
  for (const required of [
    "KINIC_IAP_AUTHORITY_IDENTITY_PEM",
    "APP_STORE_ISSUER_ID",
    "APP_STORE_KEY_ID",
    "APP_STORE_PRIVATE_KEY_PEM",
    "APP_STORE_NOTIFICATION_ROOT_SHA256"
  ]) {
    assert.ok(names.has(required), `missing sandbox Worker secret: ${required}`);
  }
}

function runGit(args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function assertGitReady() {
  const conflicts = runGit(["diff", "--name-only", "--diff-filter=U"]);
  assert.equal(conflicts.status, 0, conflicts.stderr);
  assert.equal(conflicts.stdout.trim(), "", "worktree has unresolved conflicts");

  const status = runGit(["status", "--short"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.trim(), "", "sandbox deploy requires a clean worktree");

  const fetch = runGit(["fetch", "origin", "main"]);
  assert.equal(fetch.status, 0, fetch.stderr);
  const ancestor = runGit(["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
  assert.equal(ancestor.status, 0, "HEAD must contain origin/main before sandbox deploy");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(join(paymentRoot, "wrangler.sandbox.jsonc"), "utf8"));
  const configOnly = process.argv.includes("--config-only");
  validateSandboxConfig(config, { requireProvisioned: !configOnly });
  if (!configOnly) {
    assertSandboxSecrets();
    assertGitReady();
  }
  console.log(`Sandbox deploy guard OK (${configOnly ? "configuration" : "deployment"})`);
}
