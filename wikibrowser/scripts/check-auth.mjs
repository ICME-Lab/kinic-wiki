import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const { AUTH_CLIENT_CREATE_OPTIONS, DELEGATION_TTL_NS, DERIVATION_ORIGIN } = await importTs("../lib/auth.ts");

assert.equal(DELEGATION_TTL_NS, 29n * 24n * 3_600_000_000_000n);
assert.equal(AUTH_CLIENT_CREATE_OPTIONS.idleOptions.idleTimeout, 29 * 24 * 60 * 60 * 1000);
assert.equal(AUTH_CLIENT_CREATE_OPTIONS.idleOptions.disableDefaultIdleCallback, true);
assert.equal(DERIVATION_ORIGIN, "https://xis3j-paaaa-aaaai-axumq-cai.icp0.io");

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
