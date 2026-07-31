import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importStrippedTsForTest } from "../../scripts/strip-ts-for-test.mjs";

const {
  AUTH_CLIENT_CREATE_OPTIONS,
  DELEGATION_TTL_NS,
  DERIVATION_ORIGIN,
  MAINNET_II_PROVIDER_URL,
  identityProviderUrl,
  derivationOriginUrl
} = await importTs("../lib/auth.ts");

const wranglerSource = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const wranglerConfig = JSON.parse(wranglerSource);
const packageConfig = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const serverEntrySource = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const robotsRouteSource = readFileSync(new URL("../src/routes/robots[.]txt.ts", import.meta.url), "utf8");
const sitemapRouteSource = readFileSync(new URL("../src/routes/sitemap[.]xml.ts", import.meta.url), "utf8");

assert.match(wranglerSource, /"main"\s*:\s*"src\/server\.ts"/);
assert.match(wranglerSource, /"pattern"\s*:\s*"kinic\.xyz"/);
assert.match(wranglerSource, /"pattern"\s*:\s*"wiki\.kinic\.xyz"/);
assert.match(serverEntrySource, /url\.hostname === "kinic\.xyz"/);
assert.match(serverEntrySource, /url\.hostname = "wiki\.kinic\.xyz"/);
assert.match(serverEntrySource, /Response\.redirect\(url, 308\)/);
assert.match(serverEntrySource, /X-Robots-Tag/);
assert.match(serverEntrySource, /noindex, nofollow/);
assert.match(robotsRouteSource, /Disallow: \//);
assert.match(sitemapRouteSource, /KINIC_DEPLOYMENT_ENV === "staging" \? \[\]/);

const staging = wranglerConfig.env.staging;
assert.equal(staging.name, "kinic-wiki-browser-staging");
assert.equal(staging.workers_dev, true);
assert.deepEqual(staging.routes, []);
assert.equal(staging.vars.KINIC_DEPLOYMENT_ENV, "staging");
assert.equal(staging.vars.VITE_KINIC_WIKI_CANISTER_ID, "3ryrw-kyaaa-aaaaf-qgxpq-cai");
assert.equal(staging.vars.KINIC_WIKI_CANISTER_ID, "3ryrw-kyaaa-aaaaf-qgxpq-cai");
assert.equal(staging.vars.VITE_II_DERIVATION_ORIGIN, "https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io");
assert.equal(staging.vars.KINIC_WIKI_GENERATOR_URL, "");
assert.equal(staging.r2_buckets[0].bucket_name, "kinic-wiki-link-preview-images-staging");
assert.equal(staging.queues.producers[0].queue, "kinic-wiki-generation-staging");
assert.notEqual(staging.kv_namespaces[0].id, wranglerConfig.kv_namespaces[0].id);
assert.match(packageConfig.scripts["deploy:production"], /VITE_KINIC_WIKI_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai/);
assert.match(
  packageConfig.scripts["deploy:production"],
  /VITE_II_DERIVATION_ORIGIN=https:\/\/6emaw-iyaaa-aaaay-aacka-cai\.icp0\.io/
);
assert.match(packageConfig.scripts["deploy:staging"], /VITE_KINIC_WIKI_CANISTER_ID=3ryrw-kyaaa-aaaaf-qgxpq-cai/);
assert.match(packageConfig.scripts["deploy:staging"], /check_worker_deploy_source\.mjs/);
assert.match(
  packageConfig.scripts["deploy:staging"],
  /VITE_II_DERIVATION_ORIGIN=https:\/\/3ryrw-kyaaa-aaaaf-qgxpq-cai\.icp0\.io/
);

assert.equal(DELEGATION_TTL_NS, 30n * 24n * 3_600_000_000_000n);
assert.equal(AUTH_CLIENT_CREATE_OPTIONS.idleOptions.idleTimeout, 30 * 24 * 60 * 60 * 1000);
assert.equal(AUTH_CLIENT_CREATE_OPTIONS.idleOptions.disableDefaultIdleCallback, true);
assert.equal(identityProviderUrl(), MAINNET_II_PROVIDER_URL);
assert.equal(DERIVATION_ORIGIN, "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io");
assert.equal(derivationOriginUrl({ hostname: "wiki.kinic.xyz", origin: "https://wiki.kinic.xyz" }), DERIVATION_ORIGIN);

const originalWikiHost = process.env.VITE_WIKI_IC_HOST;
const originalCanisterId = process.env.VITE_KINIC_WIKI_CANISTER_ID;
const originalIiProviderUrl = process.env.VITE_II_PROVIDER_URL;
const originalLocalIiE2e = process.env.VITE_ENABLE_LOCAL_II_E2E;
const originalDerivationOrigin = process.env.VITE_II_DERIVATION_ORIGIN;
process.env.VITE_II_DERIVATION_ORIGIN = "https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io";
assert.equal(
  derivationOriginUrl({ hostname: "kinic-wiki-browser-staging.example.workers.dev", origin: "https://kinic-wiki-browser-staging.example.workers.dev" }),
  "https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io"
);
process.env.VITE_II_DERIVATION_ORIGIN = "https://example.com/invalid-path";
assert.equal(
  derivationOriginUrl({ hostname: "example.com", origin: "https://example.com" }),
  DERIVATION_ORIGIN
);
delete process.env.VITE_II_DERIVATION_ORIGIN;
process.env.VITE_II_PROVIDER_URL = "http://id.ai.localhost:8011";
assert.equal(identityProviderUrl(), MAINNET_II_PROVIDER_URL);
process.env.VITE_WIKI_IC_HOST = "http://127.0.0.1:8011";
process.env.VITE_KINIC_WIKI_CANISTER_ID = "tz2ag-zx777-77776-aaabq-cai";
assert.equal(
  derivationOriginUrl({ hostname: "127.0.0.1", origin: "http://127.0.0.1:3100" }),
  DERIVATION_ORIGIN
);
process.env.VITE_ENABLE_LOCAL_II_E2E = "1";
assert.equal(identityProviderUrl(), "http://id.ai.localhost:8011");
assert.equal(
  derivationOriginUrl({ hostname: "mobile.local", origin: "https://mobile.local" }),
  DERIVATION_ORIGIN
);
assert.equal(
  derivationOriginUrl({ hostname: "127.0.0.1", origin: "http://127.0.0.1:3100" }),
  "http://tz2ag-zx777-77776-aaabq-cai.localhost:8011"
);
assert.equal(
  derivationOriginUrl({ hostname: "localhost", origin: "http://localhost:3100" }),
  "http://tz2ag-zx777-77776-aaabq-cai.localhost:8011"
);
assert.equal(
  derivationOriginUrl({ hostname: "localhost", origin: "http://localhost:3010" }),
  "http://tz2ag-zx777-77776-aaabq-cai.localhost:8011"
);
process.env.VITE_WIKI_IC_HOST = "https://icp0.io";
assert.equal(
  derivationOriginUrl({ hostname: "127.0.0.1", origin: "http://127.0.0.1:3100" }),
  DERIVATION_ORIGIN
);
restoreEnv("VITE_WIKI_IC_HOST", originalWikiHost);
restoreEnv("VITE_KINIC_WIKI_CANISTER_ID", originalCanisterId);
restoreEnv("VITE_II_PROVIDER_URL", originalIiProviderUrl);
restoreEnv("VITE_ENABLE_LOCAL_II_E2E", originalLocalIiE2e);
restoreEnv("VITE_II_DERIVATION_ORIGIN", originalDerivationOrigin);

console.log("Auth checks OK");

async function importTs(relativePath) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const source = readFileSync(sourcePath, "utf8");
  return importStrippedTsForTest(source);
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
