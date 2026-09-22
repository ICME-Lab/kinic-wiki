// Where: wikibrowser/scripts/check-staging-deploy.mjs
// What: Validate the staging Source Capture boundary and shared Worker token.
// Why: Browser staging must never forward a capture to production or an arbitrary database.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const staging = config.env?.staging;

assert.equal(staging?.name, "kinic-wiki-browser-staging");
assert.equal(staging?.workers_dev, true);
assert.deepEqual(staging?.routes, []);
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
  const secrets = JSON.parse(
    execFileSync("pnpm", ["exec", "wrangler", "secret", "list", "--env", "staging", "--format", "json"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8"
    })
  );
  assert.ok(
    secrets.some(({ name }) => name === "KINIC_WIKI_WORKER_TOKEN"),
    "missing staging secret: KINIC_WIKI_WORKER_TOKEN"
  );
}

console.log("staging Browser Source Capture checks OK");
