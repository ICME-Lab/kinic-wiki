// Where: workers/wiki-generator/scripts/check-staging-deploy.mjs
// What: Fail closed before a staging Generator deployment.
// Why: The permanent staging worker must stay pinned to its DB and complete secret set.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const staging = config.env?.staging;

assert.equal(staging?.name, "kinic-wiki-generator-staging");
assert.equal(staging?.workers_dev, true);
assert.deepEqual(staging?.routes, []);
assert.equal(staging?.vars?.KINIC_WIKI_CANISTER_ID, "3ryrw-kyaaa-aaaaf-qgxpq-cai");
assert.equal(staging?.vars?.KINIC_WIKI_ALLOWED_DATABASE_ID, "db_nuzrspghca5q");
assert.equal(staging?.vars?.KINIC_WIKI_WORKER_CONTEXT_CANDIDATES, "20");
assert.equal(staging?.vars?.KINIC_WIKI_WORKER_CONTEXT_SELECTIONS, "5");
assert.equal(staging?.d1_databases?.[0]?.database_name, "kinic-wiki-generator-staging");
assert.equal(staging?.d1_databases?.[0]?.database_id, "0fb15a11-05da-4afd-b306-e3b5b0af582a");
assert.equal(staging?.r2_buckets?.[0]?.bucket_name, "kinic-wiki-link-preview-images-staging");
assert.deepEqual(
  staging?.queues?.producers?.map(({ binding, queue }) => [binding, queue]),
  [
    ["WIKI_GENERATION_QUEUE", "kinic-wiki-generation-staging"],
    ["WIKI_GENERATION_DLQ", "kinic-wiki-generation-failures-staging"]
  ]
);
assert.equal(staging?.queues?.consumers?.[0]?.queue, "kinic-wiki-generation-staging");
assert.equal(staging?.queues?.consumers?.[0]?.max_retries, 5);

if (!process.argv.includes("--offline")) {
  const secrets = JSON.parse(
    execFileSync("pnpm", ["exec", "wrangler", "secret", "list", "--env", "staging", "--format", "json"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8"
    })
  );
  const names = new Set(secrets.map(({ name }) => name));
  for (const required of [
    "DEEPSEEK_API_KEY",
    "TYPESAFE_API_KEY",
    "KINIC_WIKI_WORKER_TOKEN",
    "KINIC_WIKI_WORKER_IDENTITY_PEM"
  ]) {
    assert.ok(names.has(required), `missing staging secret: ${required}`);
  }
}

console.log("staging Generator isolation and secret checks OK");
