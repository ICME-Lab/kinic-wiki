// Eight actual attached-cycle sends may be Unknown; a ninth cannot dispatch.
// Archived source fixture discards a post-receive reply. No test-only product API.
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
const { IDL } = sdk('@icp-sdk/core/candid'), { Principal } = sdk('@icp-sdk/core/principal');
const { PocketIc } = require('@dfinity/pic');
const who = (n) => Principal.selfAuthenticating(new Uint8Array(32).fill(n));
const ok = (r) => { assert.ok('Ok' in r, JSON.stringify(r, (_, v) => typeof v === 'bigint' ? String(v) : v)); return r.Ok; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const binary = process.env.POCKET_IC_BIN;
assert.ok(binary, 'POCKET_IC_BIN must identify verified PocketIC 16.1');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'pocket-ic-server 16.1.0');
const wikiBinding = execFileSync('didc', ['bind', '--target', 'js', resolve(root, 'crates/vfs_canister/vfs.did')], { encoding: 'utf8' });
const { idlFactory: wikiFactory, init } = await import(`data:text/javascript;base64,${Buffer.from(wikiBinding).toString('base64')}`);
const wikiWasm = readFileSync(resolve(root, 'target/wiki-credit-fault/build/wasm32-unknown-unknown/release/vfs_canister.wasm'));
const vaultWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vault_canister.wasm'));
const server = await startVaultPocketIc(binary); let pic;
try {
  pic = await PocketIc.create(server.getUrl()); await pic.setTime(Date.now());
  const admin = who(7);
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
  const fault = pic.createActor(() => IDL.Service({ fixture_drop_receive_reply: IDL.Func([], [], []) }), wiki.canisterId);
  fault.setPrincipal(admin);
  const amount = 100_000_000n, pending = [];
  const started = performance.now();
  for (let i = 0; i < 9; i++) {
    const wikiOwner = who(30 + i), vaultOwner = who(60 + i), op = new Uint8Array(16).fill(i + 1);
    vault.actor.setPrincipal(vaultOwner);
    const challenge = ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(i + 20)));
    wiki.actor.setPrincipal(wikiOwner);
    assert.equal(ok(await wiki.actor.approve_vault_link(challenge.challenge)).active, true);
    const db = ok(await wiki.actor.create_database({ name: `Unknown slot ${i}` })).database_id;
    ok(await wiki.actor.quote_vault_transfer(db, { Exact: amount }, op));
    assert.ok('Offered' in ok(await wiki.actor.execute_vault_transfer(op, { Exact: amount })).phase);
    vault.actor.setPrincipal(vaultOwner);
    assert.ok('Prepared' in ok(await vault.actor.prepare_wiki_credit(op)).status);
    wiki.actor.setPrincipal(wikiOwner);
    if (i < 8) await fault.fixture_drop_receive_reply();
    const outcome = await wiki.actor.execute_vault_transfer(op, { Exact: amount });
    if (i < 8) {
      assert.ok('Err' in outcome && 'Unavailable' in outcome.Err);
      assert.ok('Unknown' in ok(await wiki.actor.get_vault_transfer(op)).phase);
      pending.push({ wikiOwner, vaultOwner, op, db });
    } else {
      assert.ok('Err' in outcome && 'Capacity' in outcome.Err, JSON.stringify(outcome));
      assert.ok('Offered' in ok(await wiki.actor.get_vault_transfer(op)).phase);
      vault.actor.setPrincipal(vaultOwner);
      assert.equal(ok(await vault.actor.account_balance()), 0n);
      wiki.actor.setPrincipal(wikiOwner);
      assert.ok('Refunded' in ok(await wiki.actor.cancel_vault_transfer(op)).phase);
    }
  }
  const elapsedToCapMs = Math.round(performance.now() - started);
  const physicalAtCap = { wiki: await pic.getCyclesBalance(wiki.canisterId),
    vault: await pic.getCyclesBalance(vault.canisterId) };
  for (const { wikiOwner, vaultOwner, op, db } of pending) {
    wiki.actor.setPrincipal(wikiOwner);
    const paid = ok(await wiki.actor.reconcile_vault_transfer(op));
    assert.ok('Paid' in paid.phase);
    const entries = ok(await wiki.actor.list_database_cycle_entries(db, [], 100)).entries;
    assert.equal(entries.filter((entry) => entry.kind === 'bridge_reserve').length, 1);
    assert.equal(entries.filter((entry) => entry.kind === 'bridge_refund').length, 0);
    vault.actor.setPrincipal(vaultOwner);
    assert.equal(ok(await vault.actor.account_balance()), amount);
    const receiverCycles = await pic.getCyclesBalance(vault.canisterId);
    wiki.actor.setPrincipal(wikiOwner);
    assert.deepEqual(ok(await wiki.actor.reconcile_vault_transfer(op)), paid);
    vault.actor.setPrincipal(vaultOwner);
    assert.equal(ok(await vault.actor.account_balance()), amount);
    assert.equal(await pic.getCyclesBalance(vault.canisterId), receiverCycles);
  }
  console.log(JSON.stringify({ actualUnknownSends: 8, ninthDispatchRejected: true,
    allEightManuallyReconciledPaidOnce: true, elapsedToCapMs,
    physicalCyclesAtCap: Object.fromEntries(Object.entries(physicalAtCap).map(([k,v]) => [k,String(v)])),
    wasmSha256: { wikiFault: sha(wikiWasm), vault: sha(vaultWasm) }, deployable: false }));
} finally { try { await pic?.tearDown(); } finally { await server.stop(); } }
