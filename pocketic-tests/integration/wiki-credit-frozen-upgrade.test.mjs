// Frozen Wiki6 -> current Wiki7 upgrade, data preservation and downgrade guard.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { startVaultPocketIc } from '../helpers/vault-pocketic-server.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'target/vault-credit-baseline82');
const baseline = '82f03ce7da704e07d895cd4f1ef9df2827964148';
const require = createRequire(import.meta.url);
const sdk = createRequire(realpathSync(require.resolve('@dfinity/pic')));
const { IDL } = sdk('@icp-sdk/core/candid'), { Principal } = sdk('@icp-sdk/core/principal');
const { PocketIc } = require('@dfinity/pic');
const bind = async (did) => {
  const source = execFileSync('didc', ['bind', '--target', 'js', did], { encoding: 'utf8' });
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};
const { idlFactory: oldFactory, init } = await bind(resolve(output, 'vfs.did'));
const { idlFactory: newFactory } = await bind(resolve(root, 'crates/vfs_canister/vfs.did'));
const oldWasm = readFileSync(resolve(output, 'vfs_canister.wasm'));
const newWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vfs_canister.wasm'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(resolve(output, 'source.json'), 'utf8'));
assert.equal(manifest.baseline, baseline);
assert.equal(hash(oldWasm), manifest.artifacts.vfs_canister.sha256);
const binary = process.env.POCKET_IC_BIN;
assert.ok(binary, 'POCKET_IC_BIN must identify verified PocketIC 16.1');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'pocket-ic-server 16.1.0');
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(7));
const reader = Principal.selfAuthenticating(new Uint8Array(32).fill(8));
const ok = (r) => { assert.ok('Ok' in r, JSON.stringify(r, (_, v) => typeof v === 'bigint' ? String(v) : v)); return r.Ok; };
const server = await startVaultPocketIc(binary); let pic;
try {
  pic = await PocketIc.create(server.getUrl()); await pic.setTime(Date.now());
  const config = { kinic_ledger_canister_id: 'aaaaa-aa', billing_authority_id: owner.toText(),
    iap_authority_id: [owner.toText()], cycles_per_kinic: 1000n, min_update_cycles: 1_000_000n,
    top_up: { enabled: false, threshold_cycles: 1_000_000_000n, launcher_principal: 'aaaaa-aa' } };
  const old = await pic.setupCanister({ sender: owner, idlFactory: oldFactory, wasm: oldWasm,
    arg: IDL.encode(init({ IDL }), [config]), cycles: 100_000_000_000_000n });
  old.actor.setPrincipal(owner);
  const database = ok(await old.actor.create_database({ name: 'Frozen Wiki6 upgrade' })).database_id;
  ok(await old.actor.grant_database_cycles_from_iap({ database_id: database, provider: 'apple_iap',
    external_payment_id: 'frozen-upgrade-local', product_id: 'test.cycles',
    purchaser_principal: owner.toText(), amount_cycles: 1_000_000_000_000n }));
  ok(await old.actor.write_node({ database_id: database, path: '/upgrade.md', kind: { File: null },
    content: 'Wiki6 upgrade fixture 日本語', metadata_json: '{}', expected_etag: [] }));
  ok(await old.actor.grant_database_access(database, reader.toText(), { Reader: null }));
  const snapshot = async () => ({ databases: ok(await old.actor.list_databases()),
    members: ok(await old.actor.list_database_members(database)),
    node: ok(await old.actor.read_node(database, '/upgrade.md')),
    ledger: ok(await old.actor.list_database_cycle_entries(database, [], 100)),
    grant: ok(await old.actor.get_initial_free_database_grant_status()) });
  const before = await snapshot();
  await pic.upgradeCanister({ sender: owner, canisterId: old.canisterId, wasm: newWasm, arg: IDL.encode([], []) });
  assert.deepEqual(await snapshot(), before);
  const current = pic.createActor(newFactory, old.canisterId); current.setPrincipal(owner);
  assert.deepEqual(ok(await current.vault_bridge_config()), []);
  assert.deepEqual(ok(await current.get_pending_vault_transfer([])), []);
  old.actor.setPrincipal(reader);
  assert.equal(ok(await old.actor.read_node(database, '/upgrade.md'))[0].content, 'Wiki6 upgrade fixture 日本語');
  assert.ok('Err' in await old.actor.write_node({ database_id: database, path: '/blocked.md',
    kind: { File: null }, content: 'no', metadata_json: '{}', expected_etag: [] }));
  old.actor.setPrincipal(owner);
  const beforeDowngrade = await snapshot(); let downgradeError;
  try { await pic.upgradeCanister({ sender: owner, canisterId: old.canisterId, wasm: oldWasm, arg: IDL.encode([], []) }); }
  catch (error) { downgradeError = String(error); }
  assert.ok(downgradeError, 'Wiki6 must reject the newer schema');
  assert.deepEqual(await snapshot(), beforeDowngrade);
  const result = { baseline, targetCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    wasmSha256: { frozenWiki: hash(oldWasm), currentWiki: hash(newWasm) },
    preserved: ['balances', 'members', 'content', 'iap_grant', 'free_grant', 'ledger'],
    bridgeDefaultDisabled: true, readerReadOnly: true, downgradeRejected: true,
    realFunds: false, productionDeployment: false };
  writeFileSync(resolve(output, 'wiki-upgrade.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { try { await pic?.tearDown(); } finally { await server.stop(); } }
