import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isLocalReplicaHost } from "@kinic/vfs-client-core";
import { importStrippedTsForTest } from "../../scripts/strip-ts-for-test.mjs";

const { classifyApiError, classifyCanisterError, invalidCanisterIdError } = await importTs("../lib/api-errors.ts");

assert.equal(
  classifyApiError(new Error("Canister t63gs-up777-77776-aaaba-cai not found"), "http://127.0.0.1:8000").code,
  "canister_not_found"
);
assert.equal(
  classifyApiError(new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:8000"), "http://127.0.0.1:8000").code,
  "ic_host_unreachable"
);
assert.equal(
  classifyApiError(new Error("Canister has no query method search_nodes"), "https://icp0.io").code,
  "wiki_api_missing"
);
assert.equal(classifyApiError(new Error("replica rejected request"), "https://icp0.io").error, "Wiki request failed");
assert.equal(invalidCanisterIdError("invalid principal").error, "Invalid canister ID");
assert.equal(classifyCanisterError("database not found: testdb").code, "database_not_found");
assert.equal(classifyCanisterError("database not found: testdb").status, 404);
assert.equal(classifyCanisterError("sqlite error 1: database not found: testdb").code, "database_not_found");
assert.equal(classifyCanisterError("sqlite error 1: database not found: testdb").error, "Database not found");
assert.equal(classifyCanisterError("node not found: /Knowledge/missing.md").code, "node_not_found");
assert.equal(classifyCanisterError("node not found: /Knowledge/missing.md").status, 404);
assert.equal(classifyCanisterError("path not found: /Knowledge/missing").code, "path_not_found");
assert.equal(classifyCanisterError("path not found: /Knowledge/missing").status, 404);

console.log("API error checks OK");

async function importTs(relativePath) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const source = readFileSync(sourcePath, "utf8").replace(
    'import { isLocalReplicaHost } from "@kinic/vfs-client-core";',
    "const { isLocalReplicaHost } = globalThis.__kinicVfsClientCore;"
  );
  globalThis.__kinicVfsClientCore = { isLocalReplicaHost };
  return importStrippedTsForTest(source);
}
