import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const yaml=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");
test("Wasm ledger acceptance provisions its own Candid compiler",()=>{
const job=yaml.split("  vault-wasm-acceptance:")[1]?.split("  vault-browser-acceptance:")[0];
assert.ok(job?.includes("didc --version"),"isolated Wasm job needs pinned didc, not the fast job installation");
assert.ok(job.includes("sha256sum -c"));
});
