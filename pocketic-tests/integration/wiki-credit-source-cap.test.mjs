// Exercise the production Wiki transfer journal at its physical row limit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startVaultPocketIc } from '../helpers/vault-pocketic-server.mjs';
import { idlFactory as vaultFactory } from '../../packages/vault-candid/index.js';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const sdk = createRequire(realpathSync(require.resolve('@dfinity/pic')));
const { IDL } = sdk('@icp-sdk/core/candid');
const { Principal } = sdk('@icp-sdk/core/principal');
const { PocketIc } = require('@dfinity/pic');
const who = (n) => Principal.selfAuthenticating(new Uint8Array(32).fill(n));
const ok = (r) => { assert.ok('Ok' in r, JSON.stringify(r, (_, v) => typeof v === 'bigint' ? String(v) : v)); return r.Ok; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const binary = process.env.POCKET_IC_BIN;
assert.ok(binary, 'POCKET_IC_BIN must identify verified PocketIC 16.1');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'pocket-ic-server 16.1.0');
const wikiBinding = execFileSync('didc', ['bind', '--target', 'js', resolve(root, 'crates/vfs_canister/vfs.did')], { encoding: 'utf8' });
const { idlFactory: wikiFactory, init } = await import(`data:text/javascript;base64,${Buffer.from(wikiBinding).toString('base64')}`);
const wikiWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vfs_canister.wasm'));
const vaultWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vault_canister.wasm'));
const server = await startVaultPocketIc(binary); let pic;
try {
  pic = await PocketIc.create(server.getUrl()); await pic.setTime(Date.now());
  const admin = who(7), wikiOwner = who(44), vaultOwner = who(55);
  const config = { kinic_ledger_canister_id: 'aaaaa-aa', billing_authority_id: admin.toText(),
    iap_authority_id: [admin.toText()], cycles_per_kinic: 1000n, min_update_cycles: 1_000_000n,
    top_up: { enabled: false, threshold_cycles: 1_000_000_000n, launcher_principal: 'aaaaa-aa' } };
  const wiki = await pic.setupCanister({ sender: admin, idlFactory: wikiFactory, wasm: wikiWasm,
    arg: IDL.encode(init({ IDL }), [config]), cycles: 100_000_000_000_000n });
  const vault = await pic.setupCanister({ sender: admin, idlFactory: vaultFactory, wasm: vaultWasm,
    cycles: 100_000_000_000_000n });
  const limits = { enabled: true, daily_limit_cycles: 1_000_000_000_000n,
    physical_reserve_cycles: 10_000_000_000_000n };
  wiki.actor.setPrincipal(admin); vault.actor.setPrincipal(admin);
  ok(await wiki.actor.set_vault_bridge_config({ ...limits, peer: vault.canisterId }));
  ok(await vault.actor.set_wiki_bridge_config({ ...limits, peer: wiki.canisterId }));
  vault.actor.setPrincipal(vaultOwner);
  const challenge = ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(1)));
  wiki.actor.setPrincipal(wikiOwner);
  ok(await wiki.actor.approve_vault_link(challenge.challenge));
  const db = ok(await wiki.actor.create_database({ name: 'Source transfer row capacity' })).database_id;
  const operation = (n) => { const b = new Uint8Array(16); new DataView(b.buffer).setUint32(12, n); return b; };
  const start = performance.now();
  const cyclesBefore = await pic.getCyclesBalance(wiki.canisterId);
  for (let n = 1; n <= 1024; n++) {
    const reply = await wiki.actor.quote_vault_transfer(db, { Exact: 1n }, operation(n));
    assert.ok('Ok' in reply, `row ${n}: ${JSON.stringify(reply, (_, v) => typeof v === 'bigint' ? String(v) : v)}`);
    const quoted = reply.Ok;
    assert.ok('Quoted' in quoted.phase, `row ${n} should be Quoted`);
    assert.ok('Refunded' in ok(await wiki.actor.cancel_vault_transfer(operation(n))).phase);
  }
  const atLimitMs = Math.round(performance.now() - start);
  const cyclesAtLimit = await pic.getCyclesBalance(wiki.canisterId);
  const extra = await wiki.actor.quote_vault_transfer(db, { Exact: 1n }, operation(1025));
  assert.ok('Err' in extra && 'Capacity' in extra.Err, JSON.stringify(extra));
  assert.deepEqual(ok(await wiki.actor.get_vault_transfer(operation(1))),
    ok(await wiki.actor.quote_vault_transfer(db, { Exact: 1n }, operation(1))));
  assert.ok('Refunded' in ok(await wiki.actor.cancel_vault_transfer(operation(1))).phase);
  assert.ok('Refunded' in ok(await wiki.actor.get_vault_transfer(operation(1))).phase);
  assert.equal(ok(await vault.actor.account_balance()), 0n);
  console.log(JSON.stringify({ sourceRows: 1024, rejectedRow: 1025, existingReplayAndCancelAtLimit: true,
    elapsedToLimitMs: atLimitMs, sourceExecutionCyclesToLimit: String(cyclesBefore - cyclesAtLimit),
    wasmSha256: { wiki: sha(wikiWasm), vault: sha(vaultWasm) }, realFunds: false, productionDeployment: false }));
} finally { try { await pic?.tearDown(); } finally { await server.stop(); } }
