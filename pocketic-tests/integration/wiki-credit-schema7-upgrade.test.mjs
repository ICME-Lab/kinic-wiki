// Upgrade an actual PR #187 Wiki Wasm database from bridge schema 007 to 008.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { startVaultPocketIc } from '../helpers/vault-pocketic-server.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'target/wiki-credit-schema7');
const manifest = JSON.parse(readFileSync(resolve(output, 'source.json'), 'utf8'));
assert.equal(manifest.sourceCommit, 'b8bb9125b138927a20f81bb82db0c8979cb2a93f');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const oldWasm = readFileSync(resolve(output, 'build/wasm32-unknown-unknown/release/vfs_canister.wasm'));
assert.equal(hash(oldWasm), manifest.wasmSha256);
const newWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vfs_canister.wasm'));
const binary = process.env.POCKET_IC_BIN;
assert.ok(binary, 'POCKET_IC_BIN must identify verified PocketIC 16.1');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'pocket-ic-server 16.1.0');
const require = createRequire(import.meta.url);
const sdk = createRequire(realpathSync(require.resolve('@dfinity/pic')));
const { IDL } = sdk('@icp-sdk/core/candid');
const { Principal } = sdk('@icp-sdk/core/principal');
const { PocketIc } = require('@dfinity/pic');
const bind = async (did) => {
  const source = execFileSync('didc', ['bind', '--target', 'js', did], { encoding: 'utf8' });
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};
const { idlFactory: oldFactory, init } = await bind(resolve(output, 'source/crates/vfs_canister/vfs.did'));
const { idlFactory: newFactory } = await bind(resolve(root, 'crates/vfs_canister/vfs.did'));
const who = (n) => Principal.selfAuthenticating(new Uint8Array(32).fill(n));
const ok = (result) => {
  assert.ok('Ok' in result, JSON.stringify(result, (_, v) => typeof v === 'bigint' ? String(v) : v));
  return result.Ok;
};
const server = await startVaultPocketIc(binary); let pic;
try {
  pic = await PocketIc.create(server.getUrl()); await pic.setTime(Date.now());
  const admin = who(7), peer = who(9), vaultOwner = who(8);
  const config = { kinic_ledger_canister_id: 'aaaaa-aa', billing_authority_id: admin.toText(),
    iap_authority_id: [admin.toText()], cycles_per_kinic: 1000n, min_update_cycles: 1_000_000n,
    top_up: { enabled: false, threshold_cycles: 1_000_000_000n, launcher_principal: 'aaaaa-aa' } };
  const old = await pic.setupCanister({ sender: admin, idlFactory: oldFactory, wasm: oldWasm,
    arg: IDL.encode(init({ IDL }), [config]), cycles: 100_000_000_000_000n });
  old.actor.setPrincipal(admin);
  const database = ok(await old.actor.create_database({ name: 'Bridge schema 007' })).database_id;
  ok(await old.actor.grant_database_cycles_from_iap({ database_id: database, provider: 'apple_iap',
    external_payment_id: 'schema7-upgrade', product_id: 'test.cycles',
    purchaser_principal: admin.toText(), amount_cycles: 1_000_000_000_000n }));
  const limits = { enabled: true, daily_limit_cycles: 1_000_000_000_000n,
    physical_reserve_cycles: 10_000_000_000_000n, peer };
  ok(await old.actor.set_vault_bridge_config(limits));
  old.actor.setPrincipal(peer);
  ok(await old.actor.revoke_link_from_vault({ vault_owner: vaultOwner, through_generation: 7n }));
  old.actor.setPrincipal(admin);
  const before = { databases: ok(await old.actor.list_databases()),
    ledger: ok(await old.actor.list_database_cycle_entries(database, [], 100)),
    bridge: ok(await old.actor.vault_bridge_config()) };

  await pic.upgradeCanister({ sender: admin, canisterId: old.canisterId, wasm: newWasm,
    arg: IDL.encode([], []) });
  const current = pic.createActor(newFactory, old.canisterId); current.setPrincipal(admin);
  const after = { databases: ok(await current.list_databases()),
    ledger: ok(await current.list_database_cycle_entries(database, [], 100)),
    bridge: ok(await current.vault_bridge_config()) };
  assert.deepEqual(after, before, 'schema 007 data must survive migration 008');
  current.setPrincipal(peer);
  ok(await current.revoke_link_from_vault({ vault_owner: vaultOwner, through_generation: 8n }));
  current.setPrincipal(admin);
  assert.deepEqual(ok(await current.list_databases()), before.databases);
  console.log(JSON.stringify({ sourceCommit: manifest.sourceCommit,
    oldWasmSha256: manifest.wasmSha256, newWasmSha256: hash(newWasm),
    schema7Upgrade: true, postUpgradeRevocationAccepted: true, dataPreserved: true,
    productionDeployment: false }));
} finally { try { await pic?.tearDown(); } finally { await server.stop(); } }
