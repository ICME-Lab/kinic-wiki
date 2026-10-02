// Where: wikibrowser/scripts/check-staging-deploy.mjs
// What: Validate the staging Source Capture boundary and shared Worker token.
// Why: Browser staging must never forward a capture to production or an arbitrary database.
import assert from "node:assert/strict";
import { assertWorkerSecrets } from "../../scripts/cloudflare/secrets.mjs";
import { loadWorkerConfig } from "../../scripts/cloudflare/config.mjs";

const staging = await loadWorkerConfig(new URL("..", import.meta.url).pathname, "staging");

assert.equal(staging?.name, "kinic-wiki-browser-staging");
assert.equal(staging?.workers_dev, true);
assert.deepEqual(staging?.routes ?? [], []);
assert.equal(staging?.vars?.KINIC_WIKI_CANISTER_ID, "3ryrw-kyaaa-aaaaf-qgxpq-cai");
assert.equal(staging?.vars?.KINIC_WIKI_ALLOWED_DATABASE_ID, "db_nuzrspghca5q");
assert.equal(
  staging?.vars?.KINIC_WIKI_GENERATOR_URL,
  "https://kinic-wiki-generator-staging.hude.workers.dev"
);
assert.equal(
  staging?.vars?.KINIC_WIKI_CLIPPER_ORIGIN,
  "chrome-extension://kdildjebipiaccglghfdhjifgknlpffg"
);

if (!process.argv.includes("--offline")) {
  assertWorkerSecrets(new URL("..", import.meta.url), "kinic-wiki-browser-staging", ["KINIC_WIKI_WORKER_TOKEN"]);
}

console.log("staging Browser Source Capture checks OK");
