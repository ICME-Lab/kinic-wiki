// Where: scripts/check-mainnet-deploy-wiki.mjs
// What: Verify mainnet deploy wrapper billing principal handling without touching mainnet.
// Why: SEV fresh deploys are the default and require explicit values, while production upgrades preserve current principals.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const currentConfig = `(
  variant {
    Ok = record {
      billing_authority_id = "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae";
      kinic_ledger_canister_id = "73mez-iiaaa-aaaaq-aaasq-cai";
      top_up = record {
        enabled = true;
        threshold_cycles = 2_000_000_000_000 : nat;
        launcher_principal = "xfug4-5qaaa-aaaak-afowa-cai";
      };
      cycles_per_kinic = 234_500_000_000 : nat64;
      min_update_cycles = 1_000_000 : nat64;
    }
  },
)`;

assertDryRun(
  fakeIcp(currentConfig),
  { ICP_ENVIRONMENT: "ic" },
  /ICP_ENVIRONMENT=ic/,
  /KINIC_LEDGER_CANISTER_ID=73mez-iiaaa-aaaaq-aaasq-cai/,
  /BILLING_AUTHORITY_ID=r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae/
);

assertDryRun(
  fakeIcp(currentConfig, 0, root),
  { ICP_ENVIRONMENT: "ic" },
  /ICP_ENVIRONMENT=ic/,
  /KINIC_LEDGER_CANISTER_ID=73mez-iiaaa-aaaaq-aaasq-cai/,
  /BILLING_AUTHORITY_ID=r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae/,
  mkdtempSync(join(tmpdir(), "kinic-mainnet-deploy-cwd-"))
);

assertDryRun(
  fakeIcp("unexpected icp call", 1),
  {
    KINIC_LEDGER_CANISTER_ID: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    BILLING_AUTHORITY_ID: "aaaaa-aa"
  },
  /ICP_ENVIRONMENT=mainnet-sev/,
  /KINIC_LEDGER_CANISTER_ID=ryjl3-tyaaa-aaaaa-aaaba-cai/,
  /BILLING_AUTHORITY_ID=aaaaa-aa/
);

const failed = runDryRun(fakeIcp("variant { Err = \"missing\" }", 0), {
  ICP_ENVIRONMENT: "ic"
});
assert.notEqual(failed.status, 0);
assert.match(failed.stderr, /could not be resolved from the current mainnet cycles billing config|did not return Ok/);

const sevMissingEnv = runDryRun(fakeIcp("unexpected icp call", 1), {});
assert.notEqual(sevMissingEnv.status, 0);
assert.match(sevMissingEnv.stderr, /KINIC_LEDGER_CANISTER_ID is required for mainnet-sev fresh deploy/);

assertDryRun(
  fakeIcp("unexpected icp call", 1),
  {
    ICP_ENVIRONMENT: "mainnet-sev",
    KINIC_LEDGER_CANISTER_ID: "73mez-iiaaa-aaaaq-aaasq-cai",
    BILLING_AUTHORITY_ID: "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
  },
  /ICP_ENVIRONMENT=mainnet-sev/,
  /KINIC_LEDGER_CANISTER_ID=73mez-iiaaa-aaaaq-aaasq-cai/,
  /BILLING_AUTHORITY_ID=r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae/
);

assertDryRun(
  fakeIcp("unexpected icp call", 1),
  {
    KINIC_LEDGER_CANISTER_ID: "73mez-iiaaa-aaaaq-aaasq-cai",
    BILLING_AUTHORITY_ID: "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
  },
  ["--environment", "mainnet-sev"],
  /ICP_ENVIRONMENT=mainnet-sev/,
  /KINIC_LEDGER_CANISTER_ID=73mez-iiaaa-aaaaq-aaasq-cai/,
  /BILLING_AUTHORITY_ID=r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae/
);

console.log("mainnet deploy wrapper OK");

function assertDryRun(binDir, env, ...patternsAndCwd) {
  const cwd = typeof patternsAndCwd.at(-1) === "string" ? patternsAndCwd.pop() : root;
  const args = Array.isArray(patternsAndCwd[0]) ? patternsAndCwd.shift() : [];
  const result = runDryRun(binDir, env, cwd, args);
  assert.equal(result.status, 0, result.stderr);
  for (const pattern of patternsAndCwd) assert.match(result.stderr, pattern);
}

function runDryRun(binDir, env, cwd = root, args = []) {
  const cleanEnv = { ...process.env, ...env, PATH: `${binDir}:${process.env.PATH}` };
  if (!("KINIC_LEDGER_CANISTER_ID" in env)) delete cleanEnv.KINIC_LEDGER_CANISTER_ID;
  if (!("BILLING_AUTHORITY_ID" in env)) delete cleanEnv.BILLING_AUTHORITY_ID;
  return spawnSync("bash", [join(root, "scripts/mainnet/deploy_wiki.sh"), "--dry-run", ...args], {
    cwd,
    env: cleanEnv,
    encoding: "utf8"
  });
}

function fakeIcp(output, status = 0, expectedCwd = null) {
  const dir = mkdtempSync(join(tmpdir(), "kinic-mainnet-deploy-"));
  const script = join(dir, "icp");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
${expectedCwd === null ? "" : `if [[ "$PWD" != "${expectedCwd}" ]]; then\n  echo "unexpected icp cwd: $PWD" >&2\n  exit 3\nfi\n`}
if [[ "$*" != "canister call wiki get_cycles_billing_config () -e ic -o candid" ]]; then
  echo "unexpected icp args: $*" >&2
  exit 2
fi
cat <<'CANDID'
${output}
CANDID
exit ${status}
`
  );
  chmodSync(script, 0o755);
  return dir;
}
