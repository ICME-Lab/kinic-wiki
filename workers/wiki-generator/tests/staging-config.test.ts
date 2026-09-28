// Where: workers/wiki-generator/tests/staging-config.test.ts
// What: Lock production and staging bindings to separate resources.
// Why: Cross-environment Queue or database wiring can send private captures to production.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const packageRoot = process.cwd();
const config = JSON.parse(readFileSync(resolve(packageRoot, "wrangler.jsonc"), "utf8"));
const staging = config.env.staging;
const packageConfig = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

test("staging Generator uses only dedicated resources and database boundary", () => {
  assert.equal(staging.name, "kinic-wiki-generator-staging");
  assert.equal(staging.workers_dev, true);
  assert.deepEqual(staging.routes, []);
  assert.equal(staging.vars.KINIC_WIKI_CANISTER_ID, "3ryrw-kyaaa-aaaaf-qgxpq-cai");
  assert.equal(staging.vars.KINIC_WIKI_ALLOWED_DATABASE_ID, "db_nuzrspghca5q");
  assert.equal(staging.d1_databases[0].database_name, "kinic-wiki-generator-staging");
  assert.notEqual(staging.d1_databases[0].database_id, config.d1_databases[0].database_id);
  assert.notEqual(staging.r2_buckets[0].bucket_name, config.r2_buckets[0].bucket_name);
  assert.deepEqual(staging.queues.producers.map(({ queue }: { queue: string }) => queue), [
    "kinic-wiki-generation-staging",
    "kinic-wiki-generation-failures-staging"
  ]);
  assert.equal(staging.queues.consumers[0].queue, "kinic-wiki-generation-staging");
  assert.equal(staging.queues.consumers[0].max_retries, 5);
  assert.equal(config.vars.KINIC_WIKI_ALLOWED_DATABASE_ID, undefined);
  assert.match(packageConfig.scripts["deploy:staging"], /CLOUDFLARE_ENV=staging pnpm run build/);
  assert.match(packageConfig.scripts["deploy:staging"], /wrangler deploy --env staging --dry-run/);
});

test("offline deploy guard validates checked-in staging contract", async () => {
  const { execFileSync } = await import("node:child_process");
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, ["scripts/check-staging-deploy.mjs", "--offline"], {
      cwd: packageRoot,
      stdio: "pipe"
    })
  );
});
