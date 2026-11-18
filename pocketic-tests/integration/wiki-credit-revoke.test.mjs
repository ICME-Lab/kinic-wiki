// Real peer revocation after an offer is prepared blocks physical dispatch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { startVaultPocketIc } from '../helpers/vault-pocketic-server.mjs';
import { ledgerTypes } from '../helpers/official-icrc-ledger.mjs';
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
const wikiWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vfs_canister.wasm'));
const vaultWasm = readFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/vault_canister.wasm'));
const server = await startVaultPocketIc(binary); let pic;
try {
  pic = await PocketIc.create(server.getUrl()); await pic.setTime(Date.now());
  const admin = who(7), wikiOwner = who(8), vaultOwner = who(9);
  const successor = who(13);
  assert.notEqual(wikiOwner.toText(), vaultOwner.toText());
  const ledgerAccount = (owner) => ({ owner, subaccount: [] });
  const { Init: ledgerInit, factory: ledgerFactory } = ledgerTypes(IDL);
  const ledger = await pic.setupCanister({ sender: admin, idlFactory: ledgerFactory,
    targetCanisterId: Principal.fromText('73mez-iiaaa-aaaaq-aaasq-cai'),
    wasm: resolve(root, 'target/tools/ic-icrc1-ledger.wasm.gz'), cycles: 100_000_000_000_000n,
    arg: IDL.encode([ledgerInit], [{ Init: {
      minting_account: ledgerAccount(admin), fee_collector_account: [], transfer_fee: 100_000n,
      decimals: [8], max_memo_length: [32], token_symbol: 'TEST', token_name: 'Official local ledger',
      metadata: [], initial_balances: [[ledgerAccount(successor), 100_000_000_000n]],
      feature_flags: [{ icrc2: true }], archive_options: {
        num_blocks_to_archive: 110n, trigger_threshold: 120n, max_transactions_per_response: [100n],
        max_message_size_bytes: [], cycles_for_archive_creation: [10_000_000_000_000n],
        node_max_memory_size_bytes: [], controller_id: admin, more_controller_ids: [],
      }, index_principal: [],
    } }]) });
  const config = {
    kinic_ledger_canister_id: ledger.canisterId.toText(), billing_authority_id: admin.toText(),
    iap_authority_id: [admin.toText()], cycles_per_kinic: 2_000_000_000n, min_update_cycles: 1_000_000n,
    top_up: { enabled: false, threshold_cycles: 1_000_000_000n, launcher_principal: 'aaaaa-aa' },
  };
  const wiki = await pic.setupCanister({ sender: admin, idlFactory: wikiFactory, wasm: wikiWasm, arg: IDL.encode(init({ IDL }), [config]), cycles: 100_000_000_000_000n });
  const vault = await pic.setupCanister({ sender: admin, idlFactory: vaultFactory, wasm: vaultWasm, cycles: 100_000_000_000_000n });
  wiki.actor.setPrincipal(admin); vault.actor.setPrincipal(admin);
  const limits = { enabled: true, daily_limit_cycles: 1_000_000_000_000n, physical_reserve_cycles: 10_000_000_000_000n };
  ok(await wiki.actor.set_vault_bridge_config({ ...limits, peer: vault.canisterId }));
  ok(await vault.actor.set_wiki_bridge_config({ ...limits, peer: wiki.canisterId }));
  vault.actor.setPrincipal(vaultOwner); const challenge = ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(1)));
  wiki.actor.setPrincipal(wikiOwner); assert.equal(ok(await wiki.actor.approve_vault_link(challenge.challenge)).active, true);
  const database = ok(await wiki.actor.create_database({ name: 'Revoked bridge' })).database_id;
  const reader = who(10), writer = who(11);
  ok(await wiki.actor.grant_database_access(database, reader.toText(), { Reader: null }));
  ok(await wiki.actor.grant_database_access(database, writer.toText(), { Writer: null }));
  for (const member of [reader, writer]) {
    wiki.actor.setPrincipal(member);
    assert.ok('Err' in await wiki.actor.quote_vault_transfer(database, { Exact: 100_000_000n }, new Uint8Array(16).fill(12)));
  }
  wiki.actor.setPrincipal(wikiOwner);
  const operation = new Uint8Array(16).fill(2), amount = 1_000_000_000n;
  ok(await wiki.actor.quote_vault_transfer(database, { Exact: amount }, operation));
  const held = ok(await wiki.actor.execute_vault_transfer(operation, { Exact: amount }));
  assert.ok('Offered' in held.phase);
  vault.actor.setPrincipal(vaultOwner); assert.ok('Prepared' in ok(await vault.actor.prepare_wiki_credit(operation)).status);
  const before = { wiki: await pic.getCyclesBalance(wiki.canisterId), vault: await pic.getCyclesBalance(vault.canisterId) };
  vault.actor.setPrincipal(vaultOwner);
  ok(await vault.actor.revoke_wiki_link());
  wiki.actor.setPrincipal(wikiOwner);
  const blocked = await wiki.actor.execute_vault_transfer(operation, { Exact: amount });
  assert.ok('Err' in blocked && ('Conflict' in blocked.Err || 'Disabled' in blocked.Err), JSON.stringify(blocked));
  assert.ok('Offered' in ok(await wiki.actor.get_vault_transfer(operation)).phase);
  assert.equal(ok(await vault.actor.account_balance()), 0n);
  const canceled = ok(await wiki.actor.cancel_vault_transfer(operation));
  assert.ok('Refunded' in canceled.phase);
  assert.ok(canceled.receiver_cleanup_pending);
  const mid = ok(await wiki.actor.list_database_cycle_entries(database, [], 100));
  assert.equal(mid.entries.filter((entry) => entry.kind === 'bridge_refund').length, 1);
  await pic.advanceTime(300_001);
  const cleared = ok(await wiki.actor.reconcile_vault_transfer(operation));
  assert.ok('Refunded' in cleared.phase); assert.equal(cleared.receiver_cleanup_pending, false);
  const after = ok(await wiki.actor.list_database_cycle_entries(database, [], 100));
  assert.equal(after.entries.filter((entry) => entry.kind === 'bridge_refund').length, 1);
  assert.equal(ok(await vault.actor.account_balance()), 0n);
  const afterCycles = { wiki: await pic.getCyclesBalance(wiki.canisterId), vault: await pic.getCyclesBalance(vault.canisterId) };
  assert.ok(before.wiki - afterCycles.wiki < amount, 'no attached transfer may leave Wiki');
  assert.ok(afterCycles.vault - before.vault < amount, 'revoked receiver must not gain transfer');
  vault.actor.setPrincipal(vaultOwner);
  const relink = ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(3)));
  wiki.actor.setPrincipal(wikiOwner);
  assert.equal(ok(await wiki.actor.approve_vault_link(relink.challenge)).active, true);
  const second = new Uint8Array(16).fill(4);
  ok(await wiki.actor.quote_vault_transfer(database, { Exact: 100_000_000n }, second));
  assert.ok('Offered' in ok(await wiki.actor.execute_vault_transfer(second, { Exact: 100_000_000n })).phase);
  vault.actor.setPrincipal(vaultOwner);
  assert.ok('Prepared' in ok(await vault.actor.prepare_wiki_credit(second)).status);
  wiki.actor.setPrincipal(admin);
  ok(await wiki.actor.set_vault_bridge_config({ ...limits, peer: vault.canisterId, enabled: false }));
  wiki.actor.setPrincipal(wikiOwner);
  const disabled = await wiki.actor.execute_vault_transfer(second, { Exact: 100_000_000n });
  assert.ok('Err' in disabled && ('Disabled' in disabled.Err || 'Conflict' in disabled.Err), JSON.stringify(disabled));
  assert.ok('Refunded' in ok(await wiki.actor.cancel_vault_transfer(second)).phase);
  await pic.advanceTime(300_001);
  const secondCleanup = ok(await wiki.actor.reconcile_vault_transfer(second));
  assert.equal(secondCleanup.receiver_cleanup_pending, false);
  assert.ok('Refunded' in secondCleanup.phase);
  const finalLedger = ok(await wiki.actor.list_database_cycle_entries(database, [], 100));
  assert.equal(finalLedger.entries.filter((entry) => entry.kind === 'bridge_refund').length, 2);
  assert.equal(ok(await vault.actor.account_balance()), 0n);
  // The existing DB balance is a single pool. An authorized IAP credit and its
  // initial free grant are both eligible for an execution-time AllAvailable hold.
  wiki.actor.setPrincipal(admin);
  ok(await wiki.actor.set_vault_bridge_config({ ...limits, peer: vault.canisterId }));
  const iapAmount = 2_000_000_000n;
  ok(await wiki.actor.grant_database_cycles_from_iap({ database_id: database,
    provider: 'apple_iap', product_id: 'test.cycles', external_payment_id: 'credit-bridge-iap',
    purchaser_principal: wikiOwner.toText(), amount_cycles: iapAmount }));
  wiki.actor.setPrincipal(wikiOwner);
  const entriesBefore = ok(await wiki.actor.list_database_cycle_entries(database, [], 100)).entries;
  assert.equal(entriesBefore.filter((entry) => entry.kind === 'apple_iap').length, 1);
  const allOperation = new Uint8Array(16).fill(5);
  const allQuote = ok(await wiki.actor.quote_vault_transfer(database, { All: null }, allOperation));
  assert.ok(allQuote.balance_at_quote > iapAmount, 'free grant and IAP credit must share the DB balance');
  const allHeld = ok(await wiki.actor.execute_vault_transfer(allOperation, { AllAvailable: null }));
  assert.ok('Offered' in allHeld.phase);
  assert.ok(allHeld.offer.amount_cycles > iapAmount && allHeld.offer.amount_cycles <= allQuote.balance_at_quote);
  vault.actor.setPrincipal(vaultOwner);
  assert.ok('Prepared' in ok(await vault.actor.prepare_wiki_credit(allOperation)).status);
  wiki.actor.setPrincipal(wikiOwner);
  const allPaid = ok(await wiki.actor.execute_vault_transfer(allOperation, { AllAvailable: null }));
  assert.ok('Paid' in allPaid.phase);
  assert.equal(ok(await vault.actor.account_balance()), allHeld.offer.amount_cycles);
  const allEntries = ok(await wiki.actor.list_database_cycle_entries(database, [], 100)).entries;
  assert.equal(allEntries.filter((entry) => entry.kind === 'bridge_reserve').length, 3);
  assert.equal(allEntries.filter((entry) => entry.kind === 'bridge_refund').length, 2);
  assert.deepEqual(ok(await wiki.actor.execute_vault_transfer(allOperation, { AllAvailable: null })), allPaid);
  assert.equal(ok(await vault.actor.account_balance()), allHeld.offer.amount_cycles);
  // Move the DB's Owner role while a new offer is held. The old owner may
  // inspect/cancel the historical record, but can no longer dispatch it.
  wiki.actor.setPrincipal(admin);
  ok(await wiki.actor.grant_database_cycles_from_iap({ database_id: database,
    provider: 'apple_iap', product_id: 'test.cycles', external_payment_id: 'credit-bridge-owner-race',
    purchaser_principal: wikiOwner.toText(), amount_cycles: iapAmount }));
  const ownerRace = new Uint8Array(16).fill(6);
  wiki.actor.setPrincipal(wikiOwner);
  ok(await wiki.actor.quote_vault_transfer(database, { Exact: 100_000_000n }, ownerRace));
  assert.ok('Offered' in ok(await wiki.actor.execute_vault_transfer(ownerRace, { Exact: 100_000_000n })).phase);
  vault.actor.setPrincipal(vaultOwner);
  assert.ok('Prepared' in ok(await vault.actor.prepare_wiki_credit(ownerRace)).status);
  wiki.actor.setPrincipal(wikiOwner);
  ok(await wiki.actor.grant_database_access(database, successor.toText(), { Owner: null }));
  wiki.actor.setPrincipal(successor);
  ok(await wiki.actor.grant_database_access(database, wikiOwner.toText(), { Writer: null }));
  wiki.actor.setPrincipal(wikiOwner);
  assert.ok('Err' in await wiki.actor.execute_vault_transfer(ownerRace, { Exact: 100_000_000n }));
  assert.equal(ok(await vault.actor.account_balance()), allHeld.offer.amount_cycles);
  wiki.actor.setPrincipal(successor);
  assert.ok('Refunded' in ok(await wiki.actor.cancel_vault_transfer(ownerRace)).phase);
  await pic.advanceTime(300_001);
  assert.equal(ok(await wiki.actor.reconcile_vault_transfer(ownerRace)).receiver_cleanup_pending, false);
  assert.equal(ok(await vault.actor.account_balance()), allHeld.offer.amount_cycles);
  // The successor pays Wiki with a real ICRC-2 transfer_from on the pinned
  // official local KINIC ledger. Those confirmed DB credits can fund Vault.
  ledger.actor.setPrincipal(successor);
  ok(await ledger.actor.icrc2_approve({ from_subaccount: [], spender: ledgerAccount(wiki.canisterId),
    amount: 100_100_000n, expected_allowance: [], expires_at: [], fee: [100_000n], memo: [],
    created_at_time: [] }));
  wiki.actor.setPrincipal(successor);
  const purchase = ok(await wiki.actor.purchase_database_cycles({ database_id: database,
    payment_amount_e8s: 100_000_000n, min_expected_cycles: 2_000_000_000n }));
  assert.equal(purchase.amount_cycles, 2_000_000_000n);
  const afterPurchase = ok(await wiki.actor.list_database_cycle_entries(database, [], 100)).entries;
  assert.equal(afterPurchase.filter((entry) => entry.kind === 'cycles_purchase').length, 1);
  const successorVault = who(14);
  vault.actor.setPrincipal(successorVault);
  const successorChallenge = ok(await vault.actor.begin_wiki_link(new Uint8Array(16).fill(7)));
  wiki.actor.setPrincipal(successor);
  assert.equal(ok(await wiki.actor.approve_vault_link(successorChallenge.challenge)).active, true);
  const kinicOperation = new Uint8Array(16).fill(8), kinicTransfer = 1_000_000_000n;
  ok(await wiki.actor.quote_vault_transfer(database, { Exact: kinicTransfer }, kinicOperation));
  assert.ok('Offered' in ok(await wiki.actor.execute_vault_transfer(kinicOperation, { Exact: kinicTransfer })).phase);
  vault.actor.setPrincipal(successorVault);
  assert.ok('Prepared' in ok(await vault.actor.prepare_wiki_credit(kinicOperation)).status);
  wiki.actor.setPrincipal(successor);
  const kinicPaid = ok(await wiki.actor.execute_vault_transfer(kinicOperation, { Exact: kinicTransfer }));
  assert.ok('Paid' in kinicPaid.phase);
  vault.actor.setPrincipal(successorVault);
  assert.equal(ok(await vault.actor.account_balance()), kinicTransfer);
  wiki.actor.setPrincipal(successor);
  assert.deepEqual(ok(await wiki.actor.execute_vault_transfer(kinicOperation, { Exact: kinicTransfer })), kinicPaid);
  console.log(JSON.stringify({ revokedAfterPrepare: true, configDisabledAfterPrepare: true, readerWriterCannotQuote: true, ownershipChangeBlocksDispatch: true, physicalDispatchBlocked: true, knownUnsentRefundedOncePerOperation: true, eventualReceiverCleanup: true, freeAndIapAllAvailableCycles: String(allHeld.offer.amount_cycles), allAvailablePaidOnce: true, officialKinicPurchaseAndBridge: true, wasmSha256: { wiki: sha(wikiWasm), vault: sha(vaultWasm) }, productionDeployment: false }));
} finally { try { await pic?.tearDown(); } finally { await server.stop(); } }
