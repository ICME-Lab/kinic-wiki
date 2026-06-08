import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const {
  AUTH_CLIENT_CREATE_OPTIONS,
  DELEGATION_TTL_NS,
  DERIVATION_ORIGIN,
  MAINNET_II_PROVIDER_URL,
  identityProviderUrl,
  derivationOriginUrl
} = await importTs("../lib/auth.ts");

assert.equal(DELEGATION_TTL_NS, 29n * 24n * 3_600_000_000_000n);
assert.equal(AUTH_CLIENT_CREATE_OPTIONS.idleOptions.idleTimeout, 29 * 24 * 60 * 60 * 1000);
assert.equal(AUTH_CLIENT_CREATE_OPTIONS.idleOptions.disableDefaultIdleCallback, true);
assert.equal(identityProviderUrl(), MAINNET_II_PROVIDER_URL);
assert.equal(DERIVATION_ORIGIN, "https://xis3j-paaaa-aaaai-axumq-cai.icp0.io");
assert.equal(derivationOriginUrl({ hostname: "wiki.kinic.xyz", origin: "https://wiki.kinic.xyz" }), DERIVATION_ORIGIN);

const originalWikiHost = process.env.NEXT_PUBLIC_WIKI_IC_HOST;
const originalCanisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID;
const originalIiProviderUrl = process.env.NEXT_PUBLIC_II_PROVIDER_URL;
const originalLocalIiE2e = process.env.NEXT_PUBLIC_ENABLE_LOCAL_II_E2E;
process.env.NEXT_PUBLIC_II_PROVIDER_URL = "http://id.ai.localhost:8011";
assert.equal(identityProviderUrl(), MAINNET_II_PROVIDER_URL);
process.env.NEXT_PUBLIC_WIKI_IC_HOST = "http://127.0.0.1:8011";
process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID = "tz2ag-zx777-77776-aaabq-cai";
assert.equal(
  derivationOriginUrl({ hostname: "127.0.0.1", origin: "http://127.0.0.1:3100" }),
  DERIVATION_ORIGIN
);
process.env.NEXT_PUBLIC_ENABLE_LOCAL_II_E2E = "1";
assert.equal(identityProviderUrl(), "http://id.ai.localhost:8011");
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
process.env.NEXT_PUBLIC_WIKI_IC_HOST = "https://icp0.io";
assert.equal(
  derivationOriginUrl({ hostname: "127.0.0.1", origin: "http://127.0.0.1:3100" }),
  DERIVATION_ORIGIN
);
restoreEnv("NEXT_PUBLIC_WIKI_IC_HOST", originalWikiHost);
restoreEnv("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID", originalCanisterId);
restoreEnv("NEXT_PUBLIC_II_PROVIDER_URL", originalIiProviderUrl);
restoreEnv("NEXT_PUBLIC_ENABLE_LOCAL_II_E2E", originalLocalIiE2e);

console.log("Auth checks OK");

async function importTs(relativePath) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const source = readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
