// Fill one Vault owner's real payment journal through normal Wiki transfers.
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
const wikiWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vfs_canister.wasm'));
const vaultWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vault_canister.wasm'));
const server = await startVaultPocketIc(binary); let pic;
try {
  pic = await PocketIc.create(server.getUrl()); await pic.setTime(Date.now());
  const admin = who(7), wikiOwner = who(8), vaultOwner = who(9);
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
  assert.equal(ok(await wiki.actor.approve_vault_link(challenge.challenge)).active, true);
  const database = ok(await wiki.actor.create_database({ name: 'Receiver owner row capacity' })).database_id;
  const op = (n) => new Uint8Array(16).fill(n);
  const amount = 100_000_000n;
  const start = performance.now();
  const cyclesBefore = await pic.getCyclesBalance(vault.canisterId);
  for (let n = 2; n <= 16; n++) {
    wiki.actor.setPrincipal(wikiOwner);
    ok(await wiki.actor.quote_vault_transfer(database, { Exact: amount }, op(n)));
    assert.ok('Offered' in ok(await wiki.actor.execute_vault_transfer(op(n), { Exact: amount })).phase);
    vault.actor.setPrincipal(vaultOwner);
    assert.ok('Prepared' in ok(await vault.actor.prepare_wiki_credit(op(n))).status);
    wiki.actor.setPrincipal(wikiOwner);
    assert.ok('Paid' in ok(await wiki.actor.execute_vault_transfer(op(n), { Exact: amount })).phase);
  }
  const elapsedToOwnerLimitMs = Math.round(performance.now() - start);
  const cyclesAtOwnerLimit = await pic.getCyclesBalance(vault.canisterId);
  vault.actor.setPrincipal(vaultOwner);
  assert.equal(ok(await vault.actor.account_balance()), 15n * amount);
  wiki.actor.setPrincipal(wikiOwner);
  ok(await wiki.actor.quote_vault_transfer(database, { Exact: amount }, op(17)));
  assert.ok('Offered' in ok(await wiki.actor.execute_vault_transfer(op(17), { Exact: amount })).phase);
  vault.actor.setPrincipal(vaultOwner);
  const denied = await vault.actor.prepare_wiki_credit(op(17));
  assert.ok('Err' in denied && 'Capacity' in denied.Err, JSON.stringify(denied));
  assert.equal(ok(await vault.actor.account_balance()), 15n * amount);
  wiki.actor.setPrincipal(wikiOwner);
  assert.ok('Refunded' in ok(await wiki.actor.cancel_vault_transfer(op(17))).phase);
  assert.equal(ok(await vault.actor.account_balance()), 15n * amount);
  // The first owner occupies 16 rows. Another 504 distinct linked owners,
  // each with one paid credit, fill the global 1,024-row payment journal.
  const whoIndex = (n) => {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(28, n);
    return Principal.selfAuthenticating(bytes);
  };
  const globalStart = performance.now();
  const cyclesBeforeGlobal = await pic.getCyclesBalance(vault.canisterId);
  let lastWikiOwner, lastVaultOwner, lastOperation;
  for (let n = 1; n <= 504; n++) {
    lastVaultOwner = whoIndex(3000 + n);
    lastWikiOwner = whoIndex(2000 + n);
    lastOperation = new Uint8Array(16);
    new DataView(lastOperation.buffer).setUint32(12, n);
    vault.actor.setPrincipal(lastVaultOwner);
    const nextChallenge = ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(99)));
    wiki.actor.setPrincipal(lastWikiOwner);
    assert.equal(ok(await wiki.actor.approve_vault_link(nextChallenge.challenge)).active, true);
    const nextDb = ok(await wiki.actor.create_database({ name: `Global row ${n}` })).database_id;
    ok(await wiki.actor.quote_vault_transfer(nextDb, { Exact: amount }, lastOperation));
    assert.ok('Offered' in ok(await wiki.actor.execute_vault_transfer(lastOperation, { Exact: amount })).phase);
    vault.actor.setPrincipal(lastVaultOwner);
    assert.ok('Prepared' in ok(await vault.actor.prepare_wiki_credit(lastOperation)).status);
    wiki.actor.setPrincipal(lastWikiOwner);
    assert.ok('Paid' in ok(await wiki.actor.execute_vault_transfer(lastOperation, { Exact: amount })).phase);
  }
  const elapsedToGlobalLimitMs = Math.round(performance.now() - globalStart);
  const cyclesAtGlobalLimit = await pic.getCyclesBalance(vault.canisterId);
  vault.actor.setPrincipal(whoIndex(4000));
  const globalDenied = await vault.actor.begin_wiki_link(new Uint8Array(16).fill(88));
  assert.ok('Err' in globalDenied && 'Capacity' in globalDenied.Err, JSON.stringify(globalDenied));
  vault.actor.setPrincipal(lastVaultOwner);
  assert.equal(ok(await vault.actor.account_balance()), amount);
  wiki.actor.setPrincipal(lastWikiOwner);
  assert.ok('Paid' in ok(await wiki.actor.get_vault_transfer(lastOperation)).phase);
  vault.actor.setPrincipal(admin);
  assert.equal(ok(await vault.actor.global_capacity()).accounting_reserved, 16n * 1024n * 1024n);
  console.log(JSON.stringify({ receiverOwnerRows: 16, linkRows: 1, paidCreditRows: 15,
    seventeenthOwnerRowDeniedBeforeSend: true, knownUnsentRefundAtLimit: true,
    elapsedToOwnerLimitMs, receiverPhysicalCyclesDelta: String(cyclesAtOwnerLimit - cyclesBefore),
    receiverGlobalRows: 1024, newLinkAtGlobalLimitRejected: true,
    oldPaidTransferReadableAtGlobalLimit: true, elapsedToGlobalLimitMs,
    receiverPhysicalCyclesDeltaToGlobalLimit: String(cyclesAtGlobalLimit - cyclesBeforeGlobal),
    wasmSha256: { wiki: sha(wikiWasm), vault: sha(vaultWasm) }, realFunds: false, productionDeployment: false }));
} finally { try { await pic?.tearDown(); } finally { await server.stop(); } }
