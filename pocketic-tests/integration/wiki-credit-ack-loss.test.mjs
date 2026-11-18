// Real terminal ACK loss, receiver GC and raw operation-key reuse.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
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
assert.ok(binary, 'POCKET_IC_BIN must point to the verified PocketIC 16.1 server');
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'pocket-ic-server 16.1.0');
const wikiBinding = execFileSync('didc', ['bind', '--target', 'js', resolve(root, 'crates/vfs_canister/vfs.did')], { encoding: 'utf8' });
const { idlFactory: wikiFactory, init } = await import(`data:text/javascript;base64,${Buffer.from(wikiBinding).toString('base64')}`);
const wikiWasm = readFileSync(resolve(root, 'target/wiki-credit-fault/build/wasm32-unknown-unknown/release/vfs_canister.wasm'));
const vaultWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vault_canister.wasm'));
const server = await startVaultPocketIc(binary); let pic;
try {
  pic = await PocketIc.create(server.getUrl()); await pic.setTime(Date.now());
  const admin = who(7), wikiOwner = who(8), vaultOwner = who(9);
  assert.notEqual(wikiOwner.toText(), vaultOwner.toText());
  const config = {
    kinic_ledger_canister_id: 'aaaaa-aa', billing_authority_id: admin.toText(),
    iap_authority_id: [admin.toText()], cycles_per_kinic: 1000n, min_update_cycles: 1_000_000n,
    top_up: { enabled: false, threshold_cycles: 1_000_000_000n, launcher_principal: 'aaaaa-aa' },
  };
  const wiki = await pic.setupCanister({ sender: admin, idlFactory: wikiFactory, wasm: wikiWasm, arg: IDL.encode(init({ IDL }), [config]), cycles: 100_000_000_000_000n });
  const vault = await pic.setupCanister({ sender: admin, idlFactory: vaultFactory, wasm: vaultWasm, cycles: 100_000_000_000_000n });
  wiki.actor.setPrincipal(admin); vault.actor.setPrincipal(admin);
  const limits = { enabled: true, daily_limit_cycles: 1_000_000_000_000n, physical_reserve_cycles: 10_000_000_000_000n };
  ok(await wiki.actor.set_vault_bridge_config({ ...limits, peer: vault.canisterId }));
  ok(await vault.actor.set_wiki_bridge_config({ ...limits, peer: wiki.canisterId }));
  const fault = pic.createActor(() => IDL.Service({ fixture_drop_credit_ack_reply: IDL.Func([], [], []) }), wiki.canisterId);
  fault.setPrincipal(admin);
  vault.actor.setPrincipal(vaultOwner); const challenge = ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(1)));
  wiki.actor.setPrincipal(wikiOwner); assert.equal(ok(await wiki.actor.approve_vault_link(challenge.challenge)).active, true);
  const database = ok(await wiki.actor.create_database({ name: 'ACK recovery bridge' })).database_id;
  const operation = new Uint8Array(16).fill(2), amount = 1_000_000_000n;
  ok(await wiki.actor.quote_vault_transfer(database, { Exact: amount }, operation));
  const held = ok(await wiki.actor.execute_vault_transfer(operation, { Exact: amount }));
  assert.ok('Offered' in held.phase);
  vault.actor.setPrincipal(vaultOwner); assert.ok('Prepared' in ok(await vault.actor.prepare_wiki_credit(operation)).status);
  const before = { wiki: await pic.getCyclesBalance(wiki.canisterId), vault: await pic.getCyclesBalance(vault.canisterId) };
  await fault.fixture_drop_credit_ack_reply();
  wiki.actor.setPrincipal(wikiOwner);
  const paidPending = ok(await wiki.actor.execute_vault_transfer(operation, { Exact: amount }));
  assert.ok('Paid' in paidPending.phase);
  assert.equal(paidPending.receiver_cleanup_pending, true);
  assert.equal(ok(await vault.actor.account_balance()), amount);
  const afterSend = { wiki: await pic.getCyclesBalance(wiki.canisterId), vault: await pic.getCyclesBalance(vault.canisterId) };
  assert.ok(before.wiki - afterSend.wiki >= amount);
  assert.ok(afterSend.vault - before.vault > 0n && afterSend.vault - before.vault <= amount);
  const ledger = ok(await wiki.actor.list_database_cycle_entries(database, [], 100));
  const bridgeEntries = ledger.entries.filter((entry) => entry.kind.startsWith('bridge_'));
  await pic.advanceTime(172_800_001);
  vault.actor.setPrincipal(vaultOwner);
  // Admission of another operation runs the receiver's retention GC first.
  ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(22)));
  const reused = ok(await vault.actor.begin_wiki_link(operation));
  assert.equal(reused.vault_owner.toText(), vaultOwner.toText());
  wiki.actor.setPrincipal(wikiOwner);
  const cleared = ok(await wiki.actor.reconcile_vault_transfer(operation));
  assert.ok('Paid' in cleared.phase);
  assert.equal(cleared.receiver_cleanup_pending, false);
  assert.equal(cleared.offer.amount_cycles, amount);
  const afterCleanupLedger = ok(await wiki.actor.list_database_cycle_entries(database, [], 100));
  assert.deepEqual(afterCleanupLedger.entries.filter((entry) => entry.kind.startsWith('bridge_')), bridgeEntries);
  assert.equal(ok(await vault.actor.account_balance()), amount);
  vault.actor.setPrincipal(vaultOwner);
  assert.deepEqual(ok(await vault.actor.begin_wiki_link(operation)), reused);
  console.log(JSON.stringify({ actualAttachedCycles: String(amount), lostAckAfterRealPeerCommit: true, receiverGcAndKeyReuse: true, terminalCleanupWithoutMoneyChange: true, wasmSha256: { wikiFault: sha(wikiWasm), vault: sha(vaultWasm) }, deployable: false }));
} finally { try { await pic?.tearDown(); } finally { await server.stop(); } }
