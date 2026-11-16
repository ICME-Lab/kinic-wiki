import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const yaml=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");
test("Wasm ledger acceptance provisions its own Candid compiler",()=>{
const job=yaml.split("  vault-wasm-acceptance:")[1]?.split("  vault-browser-acceptance:")[0];
assert.ok(job?.includes("didc --version"),"isolated Wasm job needs pinned didc, not the fast job installation");
assert.ok(job.includes("sha256sum -c"));
});

test("browser job pins launcher path without an unauthenticated latest lookup",()=>{
const job=yaml.split("  vault-browser-acceptance:")[1];
assert.ok(job.includes("ICP_CLI_NETWORK_LAUNCHER_PATH"),"fresh icp home otherwise calls GitHub latest API and can hit shared runner rate limits");
assert.ok(job.includes("c843d039fbcada6d4ef5fa5dbfcff772c938a8b5e5d0e034fce52dc44f2bd001"));
});
