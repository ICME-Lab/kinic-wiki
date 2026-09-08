// Exercise the real wrapper without real IC commands, Git state, credentials, or builds.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const canister = "6emaw-iyaaa-aaaay-aacka-cai";
const controller = "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae";
const moduleHash = "0x184c5eea473b84fd12346129f10ee41fb2580ff7cc1a90997a2ea0e5bb461c0a";
const billing = `record {
 billing_authority_id = "${controller}";
 kinic_ledger_canister_id = "73mez-iiaaa-aaaaq-aaasq-cai";
 enabled = true;
 threshold_cycles = 2_000_000_000_000 : nat;
 launcher_principal = "xfug4-5qaaa-aaaak-afowa-cai";
 cycles_per_kinic = 234_500_000_000 : nat64;
 min_update_cycles = 1_000_000 : nat64;
}`;
const sandbox = mkdtempSync(join(tmpdir(), "kinic-mainnet-wrapper-test-"));
let cases = 0;

function run({ args = [], config = {}, env = {}, success = false, error, events } = {}) {
  const dir = join(sandbox, String(++cases));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, "scripts/mainnet"), { recursive: true });
  copyFileSync(join(root, "scripts/mainnet/deploy_wiki.sh"), join(dir, "scripts/mainnet/deploy_wiki.sh"));
  const log = join(dir, "events.jsonl");
  writeFileSync(log, "");
  writeFileSync(join(dir, "fixture.json"), JSON.stringify({
    branch: "feat/iap-mainnet-backport", ancestor: true, dirty: "",
    status: { id: canister, module_hash: moduleHash, settings: { controllers: [controller] } },
    billing, ...config
  }));
  const dispatcher = join(dir, "dispatcher.mjs");
  writeFileSync(dispatcher, `#!${process.execPath}
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
const config = JSON.parse(readFileSync(process.env.FIXTURE, 'utf8'));
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
function event(name) {
  appendFileSync(process.env.EVENT_LOG, JSON.stringify({ name, args, environment: process.env.ICP_ENVIRONMENT }) + '\\n');
  if (config.fail === name) { console.error('mock failure: ' + name); process.exit(1); }
}
if (command === 'git') {
  if (args.join(' ') === 'branch --show-current') console.log(config.branch);
  else if (args.join(' ') === 'merge-base --is-ancestor 83bbb0b6 HEAD') process.exit(config.ancestor ? 0 : 1);
  else if (args.join(' ') === 'status --porcelain') process.stdout.write(config.dirty);
  else throw new Error('unexpected git arguments: ' + args);
} else if (command === 'icp') {
  const identityIndex = args.indexOf('--identity');
  if (identityIndex >= 0) {
    if (args[identityIndex + 1] !== 'test-only') throw new Error('unexpected identity');
    args.splice(identityIndex, 2);
  }
  const signature = args.join(' ');
  if (signature === 'canister status wiki -e mainnet-sev --json') { event('status'); console.log(JSON.stringify(config.status)); }
  else if (signature === 'canister call wiki get_cycles_billing_config () --query -e mainnet-sev --output candid') { event('billing'); console.log(config.billing); }
  else if (signature === 'canister snapshot create wiki -e mainnet-sev -q') { event('snapshot'); console.log('test-snapshot'); }
  else if (args.slice(0, 7).join(' ') === 'deploy wiki -e mainnet-sev --mode upgrade --args-file' && args.length === 8) {
    const payload = readFileSync(args[7], 'utf8');
    if (!payload.includes('iap_authority_id = opt "hcums-tc6dw-saet6-tkznz-mkldy-lwq47-2pehv-uoq3u-6a22c-mqfsh-5qe"')) throw new Error('wrong authority');
    const logs = readdirSync('.local/mainnet-snapshots');
    if (logs.length !== 1 || !readFileSync('.local/mainnet-snapshots/' + logs[0], 'utf8').includes('snapshot_id=test-snapshot')) throw new Error('snapshot not recorded before deploy');
    event('deploy');
  } else throw new Error('unexpected icp arguments: ' + args);
} else if (command === 'didc') {
  if (args.slice(0, 5).join(' ') !== 'encode -d crates/vfs_canister/vfs.did -t (CyclesBillingConfig)') throw new Error('unexpected candid arguments');
  event('encode');
} else if (command === 'check-mainnet-candid-compat.mjs') event('compatibility');
else if (command === 'build-vfs-canister.sh') event('build');
else throw new Error('unexpected command: ' + command);
`, { mode: 0o755 });
  for (const name of ["git", "icp", "didc"]) symlinkSync(dispatcher, join(bin, name));
  for (const name of ["check-mainnet-candid-compat.mjs", "build-vfs-canister.sh"]) {
    symlinkSync(dispatcher, join(dir, "scripts", name));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  // Allowlist local utilities: real icp, Git, Cargo, and didc cannot be resolved.
  for (const name of ["bash", "dirname", "mktemp", "cat", "rm", "mkdir", "date", "chmod"]) {
    const utility = spawnSync("which", [name], { encoding: "utf8" });
    assert.equal(utility.status, 0, name);
    symlinkSync(utility.stdout.trim(), join(bin, name));
  }
  const result = spawnSync(join(bin, "bash"), [join(dir, "scripts/mainnet/deploy_wiki.sh"), ...args], {
    cwd: dir,
    env: { PATH: bin, TMPDIR: dir, FIXTURE: join(dir, "fixture.json"), EVENT_LOG: log, ...env },
    encoding: "utf8"
  });
  assert.equal(result.status === 0, success, result.stderr);
  if (error) assert.match(result.stderr, error);
  const recorded = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  if (events) assert.deepEqual(recorded.map(({ name }) => name), events);
  if (!success) assert.ok(!recorded.some(({ name }) => name === "deploy"));
  return { dir, result, recorded };
}

const preflight = ["status", "billing", "compatibility", "build", "encode"];
const execute = { args: ["--execute"], env: { CONFIRM_MAINNET_IAP_UPGRADE: canister } };
try {
  const checked = run({ success: true, events: preflight });
  assert.match(checked.result.stdout, /mainnet IAP upgrade preflight: PASS/);
  assert.equal(checked.recorded.find(({ name }) => name === "build").environment, "mainnet-sev");
  const deployed = run({ ...execute, success: true, events: [...preflight, "snapshot", "deploy"] });
  const logs = readdirSync(join(deployed.dir, ".local/mainnet-snapshots"));
  assert.equal(logs.length, 1);
  const snapshot = join(deployed.dir, ".local/mainnet-snapshots", logs[0]);
  assert.equal(statSync(snapshot).mode & 0o777, 0o600);
  assert.match(readFileSync(snapshot, "utf8"), /snapshot_id=test-snapshot/);
  assert.ok(readFileSync(snapshot, "utf8").includes(`pre_upgrade_module_hash=${moduleHash}`));
  run({ ...execute, env: { ...execute.env, DEPLOY_IDENTITY: "test-only" }, success: true, events: [...preflight, "snapshot", "deploy"] });
  run({ ...execute, config: { branch: "main" }, error: /must run from/, events: [] });
  run({ ...execute, config: { ancestor: false }, error: /does not descend/, events: [] });
  run({ ...execute, config: { dirty: " M tracked-file\n" }, error: /clean worktree/, events: [] });
  for (const status of [
    { id: "wrong", module_hash: moduleHash, settings: { controllers: [controller] } },
    { id: canister, module_hash: "wrong", settings: { controllers: [controller] } },
    { id: canister, module_hash: moduleHash, settings: { controllers: [] } }
  ]) run({ ...execute, config: { status }, error: /unexpected canister|hash drifted|unexpected controllers/, events: ["status"] });
  for (const line of billing.split("\n").filter((line) => line.includes("="))) {
    run({ ...execute, config: { billing: billing.replace(line, "") }, error: /billing config mismatch/, events: ["status", "billing"] });
  }
  run({ args: ["--execute"], error: /to authorize/, events: preflight });
  run({ args: ["--execute"], env: { CONFIRM_MAINNET_IAP_UPGRADE: "wrong" }, error: /to authorize/, events: preflight });
  for (const fail of [...preflight, "snapshot"]) {
    const all = [...preflight, "snapshot"];
    run({ ...execute, config: { fail }, error: /mock failure/, events: all.slice(0, all.indexOf(fail) + 1) });
  }
  for (const args of [["--reinstall"], ["--mode=reinstall"], ["--mode", "reinstall"], ["--dry-run"], ["--execute", "extra"]]) {
    run({ args, error: /forbidden|usage:/, events: [] });
  }
  console.log(`mainnet deploy wrapper: PASS (${cases} isolated scenarios)`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
