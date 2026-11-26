// Real predecessor Wasm -> current, then rejected downgrade with actual bridge receipts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startVaultPocketIc } from '../helpers/vault-pocketic-server.mjs';
import { idlFactory as vaultFactory } from '../../packages/vault-candid/index.js';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const sdk = createRequire(realpathSync(require.resolve('@dfinity/pic')));
const { IDL } = sdk('@icp-sdk/core/candid');
const { Principal } = sdk('@icp-sdk/core/principal');
const { PocketIc } = require('@dfinity/pic');
const bind = async (path) => {
  const source = execFileSync('didc', ['bind', '--target', 'js', path], { encoding: 'utf8' });
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};
const output = resolve(root, 'target/vault-schema9-baseline');
const predecessor = JSON.parse(readFileSync(resolve(output, 'source.json'), 'utf8'));
const oldWasm = readFileSync(predecessor.wasm);
const hash = (data) => createHash('sha256').update(data).digest('hex');
assert.equal(hash(oldWasm), predecessor.wasm_sha256);
const old = await bind(resolve(output, 'source/crates/vault_canister/vault.did'));
const wikiBinding = await bind(resolve(root, 'crates/vfs_canister/vfs.did'));
const wikiWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vfs_canister.wasm'));
const currentWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vault_canister.wasm'));
const binary = process.env.POCKET_IC_BIN;
assert.ok(binary, 'POCKET_IC_BIN must identify verified PocketIC 16.1');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'pocket-ic-server 16.1.0');
const who = (n) => Principal.selfAuthenticating(new Uint8Array(32).fill(n));
const admin = who(71), wikiOwner = who(72), vaultOwner = who(73);
const ok = (r) => { assert.ok('Ok' in r, JSON.stringify(r, (_, v) => typeof v === 'bigint' ? String(v) : v)); return r.Ok; };
const server = await startVaultPocketIc(binary);
let pic;
try {
  pic = await PocketIc.create(server.getUrl());
  await pic.setTime(Date.now());
  const vault = await pic.setupCanister({ sender: admin, idlFactory: old.idlFactory,
    wasm: oldWasm, cycles: 100_000_000_000_000n });
  vault.actor.setPrincipal(vaultOwner);
  assert.equal(ok(await vault.actor.account_balance()), 0n);
  await pic.tick(150);
  await pic.upgradeCanister({ sender: admin, canisterId: vault.canisterId,
    wasm: currentWasm, arg: IDL.encode([], []) });
  const actor = pic.createActor(vaultFactory, vault.canisterId);
  actor.setPrincipal(vaultOwner);
  assert.equal(ok(await actor.account_balance()), 0n);
  const config = { kinic_ledger_canister_id: 'aaaaa-aa', billing_authority_id: admin.toText(),
    iap_authority_id: [admin.toText()], cycles_per_kinic: 1000n, min_update_cycles: 1_000_000n,
    top_up: { enabled: false, threshold_cycles: 1_000_000_000n, launcher_principal: 'aaaaa-aa' } };
  const wiki = await pic.setupCanister({ sender: admin, idlFactory: wikiBinding.idlFactory,
    wasm: wikiWasm, arg: IDL.encode(wikiBinding.init({ IDL }), [config]), cycles: 100_000_000_000_000n });
  const limits = { enabled: true, daily_limit_cycles: 1_000_000_000_000n, physical_reserve_cycles: 10_000_000_000_000n };
  actor.setPrincipal(admin);
  ok(await actor.set_wiki_bridge_config({ ...limits, peer: wiki.canisterId }));
  wiki.actor.setPrincipal(admin);
  ok(await wiki.actor.set_vault_bridge_config({ ...limits, peer: vault.canisterId }));
  actor.setPrincipal(vaultOwner);
  const challenge = ok(await actor.begin_wiki_link(new Uint8Array(16).fill(1)));
  wiki.actor.setPrincipal(wikiOwner);
  ok(await wiki.actor.approve_vault_link(challenge.challenge));
  const database = ok(await wiki.actor.create_database({ name: 'Schema9 downgrade regression' })).database_id;
  const amount = 100_000_000n;
  const prepare = async (n) => {
    const operation = new Uint8Array(16).fill(n);
    wiki.actor.setPrincipal(wikiOwner);
    ok(await wiki.actor.quote_vault_transfer(database, { Exact: amount }, operation));
    const held = ok(await wiki.actor.execute_vault_transfer(operation, { Exact: amount }));
    assert.ok('Offered' in held.phase);
    actor.setPrincipal(vaultOwner);
    assert.ok('Prepared' in ok(await actor.prepare_wiki_credit(operation)).status);
    return held.offer;
  };
  const acceptedOffer = await prepare(2);
  const paid = ok(await wiki.actor.execute_vault_transfer(acceptedOffer.operation, { Exact: amount }));
  assert.ok('Paid' in paid.phase);
  const preparedOffer = await prepare(3);
  actor.setPrincipal(wiki.canisterId);
  const before = [ok(await actor.wiki_credit_status(acceptedOffer)), ok(await actor.wiki_credit_status(preparedOffer))];
  assert.ok('Accepted' in before[0].status);
  assert.ok('Prepared' in before[1].status);
  actor.setPrincipal(vaultOwner);
  const balance = ok(await actor.account_balance());
  assert.equal(balance, amount);
  // Same-version upgrade preserves both receipt variants and account balance.
  await pic.tick(150);
  await pic.upgradeCanister({ sender: admin, canisterId: vault.canisterId, wasm: currentWasm, arg: IDL.encode([], []) });
  let downgradeError;
  try {
    await pic.tick(150);
    await pic.upgradeCanister({ sender: admin, canisterId: vault.canisterId, wasm: oldWasm, arg: IDL.encode([], []) });
  } catch (error) { downgradeError = String(error); }
  assert.ok(downgradeError, 'PR #177 schema9 binary must reject the bridge store');
  assert.match(downgradeError, /Vault initialization failed: Storage/);
  assert.equal(ok(await actor.account_balance()), balance);
  actor.setPrincipal(wiki.canisterId);
  assert.deepEqual([ok(await actor.wiki_credit_status(acceptedOffer)), ok(await actor.wiki_credit_status(preparedOffer))], before);
  // The failed downgrade leaves the newer code operational: settle the prepared offer once.
  wiki.actor.setPrincipal(wikiOwner);
  assert.ok('Paid' in ok(await wiki.actor.execute_vault_transfer(preparedOffer.operation, { Exact: amount })).phase);
  assert.ok('Paid' in ok(await wiki.actor.reconcile_vault_transfer(preparedOffer.operation)).phase);
  actor.setPrincipal(vaultOwner);
  assert.equal(ok(await actor.account_balance()), amount * 2n);
  const report = { predecessor, current_wasm_sha256: hash(currentWasm), source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    working_tree_diff_sha256: hash(execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })),
    schema9Upgrade: true, preparedAndAcceptedPreserved: true, downgradeRejected: true,
    preparedSettlesOnceAfterRejectedDowngrade: true, downgradeError, productionDeployment: false, realFunds: false };
  writeFileSync(resolve(output, 'upgrade.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('PASS actual PR #177 schema9 upgrade; Prepared/Accepted receipts survive rejected downgrade and settle once');
} finally { try { await pic?.tearDown(); } finally { await server.stop(); } }
