// Where: scripts/check-staging-deploy-wiki.mjs
// What: Verify the staging deploy wrapper's fixed target and II origin validation.
// Why: A staging command must never deploy to the production canister or accept an unsafe origin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts", "staging", "deploy_wiki.sh");

const valid = run("https://kinic-wiki-browser-staging.example.workers.dev", "2vxsx-fae");
assert.equal(valid.status, 0, valid.stderr);
assert.match(valid.stderr, /CANISTER_ID=3ryrw-kyaaa-aaaaf-qgxpq-cai/);
assert.match(valid.stderr, /KINIC_VFS_STAGING_II_ORIGIN=https:\/\/kinic-wiki-browser-staging\.example\.workers\.dev/);
assert.match(valid.stderr, /IAP_AUTHORITY_ID=2vxsx-fae/);

for (const invalidOrigin of [
  "",
  "http://kinic-wiki-browser-staging.example.workers.dev",
  "https://kinic-wiki-browser-staging.example.workers.dev/path"
]) {
  const invalid = run(invalidOrigin, "2vxsx-fae");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must be an HTTPS origin without a path/);
}

for (const invalidAuthority of ["", "not-a-principal"]) {
  const invalid = run("https://kinic-wiki-browser-staging.example.workers.dev", invalidAuthority);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /IAP_AUTHORITY_ID (?:is required|must be a valid principal)/);
}

console.log("Staging deploy wrapper OK");

function run(origin, iapAuthorityId) {
  const env = {
    ...process.env,
    KINIC_VFS_STAGING_II_ORIGIN: origin,
    IAP_AUTHORITY_ID: iapAuthorityId
  };
  return spawnSync("bash", [script, "--dry-run"], {
    cwd: root,
    env,
    encoding: "utf8"
  });
}
