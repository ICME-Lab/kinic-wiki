// Where: scripts/check-mainnet-deploy-wiki.mjs
// What: Verify mainnet deploy wrapper billing principal handling without touching mainnet.
// Why: Schema reset makes old-mainnet upgrades unsupported; fresh SEV deploys require explicit values.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

assertDryRun(
  tempBinDir(),
  {
    KINIC_LEDGER_CANISTER_ID: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    BILLING_AUTHORITY_ID: "aaaaa-aa"
  },
  /ICP_ENVIRONMENT=mainnet-sev/,
  /KINIC_LEDGER_CANISTER_ID=ryjl3-tyaaa-aaaaa-aaaba-cai/,
  /BILLING_AUTHORITY_ID=aaaaa-aa/
);

const oldMainnet = runDryRun(tempBinDir(), {
  ICP_ENVIRONMENT: "old-mainnet",
  KINIC_LEDGER_CANISTER_ID: "73mez-iiaaa-aaaaq-aaasq-cai",
  BILLING_AUTHORITY_ID: "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
});
assert.notEqual(oldMainnet.status, 0);
assert.match(oldMainnet.stderr, /fresh mainnet-sev only/);

const oldMainnetArg = runDryRun(
  tempBinDir(),
  {
    KINIC_LEDGER_CANISTER_ID: "73mez-iiaaa-aaaaq-aaasq-cai",
    BILLING_AUTHORITY_ID: "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
  },
  root,
  ["--environment", "old-mainnet"]
);
assert.notEqual(oldMainnetArg.status, 0);
assert.match(oldMainnetArg.stderr, /fresh mainnet-sev only/);

const ambiguousIc = runDryRun(tempBinDir(), {
  ICP_ENVIRONMENT: "ic",
  KINIC_LEDGER_CANISTER_ID: "73mez-iiaaa-aaaaq-aaasq-cai",
  BILLING_AUTHORITY_ID: "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
});
assert.notEqual(ambiguousIc.status, 0);
assert.match(ambiguousIc.stderr, /fresh mainnet-sev only/);

const sevMissingEnv = runDryRun(tempBinDir(), {});
assert.notEqual(sevMissingEnv.status, 0);
assert.match(sevMissingEnv.stderr, /KINIC_LEDGER_CANISTER_ID is required/);

for (const invalidPrincipal of [
  '73mez-iiaaa-aaaaq-aaasq-cai"',
  "73mez-iiaaa-aaaaq-aaasq-cai;",
  "73mez-iiaaa-aaaaq-aaasq-cai(",
  "73MEZ-iiaaa-aaaaq-aaasq-cai"
]) {
  const invalidLedgerPrincipal = runDryRun(tempBinDir(), {
    KINIC_LEDGER_CANISTER_ID: invalidPrincipal,
    BILLING_AUTHORITY_ID: "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
  });
  assert.notEqual(invalidLedgerPrincipal.status, 0);
  assert.match(
    invalidLedgerPrincipal.stderr,
    /KINIC_LEDGER_CANISTER_ID must be a textual principal using lowercase letters, digits, and hyphens only/
  );
}

const whitespacePrincipal = runDryRun(tempBinDir(), {
  KINIC_LEDGER_CANISTER_ID: "73mez-iiaaa-aaaaq-aaasq-cai bad",
  BILLING_AUTHORITY_ID: "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
});
assert.notEqual(whitespacePrincipal.status, 0);
assert.match(whitespacePrincipal.stderr, /KINIC_LEDGER_CANISTER_ID must not contain whitespace/);

assertDryRun(
  tempBinDir(),
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
  tempBinDir(),
  {
    KINIC_LEDGER_CANISTER_ID: "73mez-iiaaa-aaaaq-aaasq-cai",
    BILLING_AUTHORITY_ID: "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
  },
  ["--environment", "mainnet-sev"],
  /ICP_ENVIRONMENT=mainnet-sev/,
  /KINIC_LEDGER_CANISTER_ID=73mez-iiaaa-aaaaq-aaasq-cai/,
  /BILLING_AUTHORITY_ID=r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae/
);

assertDeploy(
  fakeDeployIcp(),
  {
    KINIC_LEDGER_CANISTER_ID: "73mez-iiaaa-aaaaq-aaasq-cai",
    BILLING_AUTHORITY_ID: "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
  }
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
  const cleanEnv = testEnv(binDir, env);
  return spawnSync("bash", [join(root, "scripts/mainnet/deploy_wiki.sh"), "--dry-run", ...args], {
    cwd,
    env: cleanEnv,
    encoding: "utf8"
  });
}

function assertDeploy(binDir, env, args = []) {
  const result = spawnSync("bash", [join(root, "scripts/mainnet/deploy_wiki.sh"), ...args], {
    cwd: root,
    env: testEnv(binDir, env),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
}

function tempBinDir() {
  return mkdtempSync(join(tmpdir(), "kinic-mainnet-deploy-"));
}

function testEnv(binDir, env) {
  const cleanEnv = { ...process.env, ...env, PATH: `${binDir}:${process.env.PATH}` };
  if (!("KINIC_LEDGER_CANISTER_ID" in env)) delete cleanEnv.KINIC_LEDGER_CANISTER_ID;
  if (!("BILLING_AUTHORITY_ID" in env)) delete cleanEnv.BILLING_AUTHORITY_ID;
  return cleanEnv;
}

function fakeDeployIcp() {
  const dir = mkdtempSync(join(tmpdir(), "kinic-mainnet-deploy-"));
  const script = join(dir, "icp");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "deploy" || "$2" != "wiki" || "$3" != "-e" || "$4" != "mainnet-sev" || "$5" != "--args-file" || -z "$6" ]]; then
  echo "unexpected icp args: $*" >&2
  exit 2
fi
if [[ ! -s "$6" ]]; then
  echo "missing args file: $6" >&2
  exit 3
fi
exit 0
`
  );
  chmodSync(script, 0o755);
  return dir;
}
