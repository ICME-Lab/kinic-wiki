// Run with test:bekko-refill-faults. Only the deposit transport is substituted in
// the delayed-response Wasm; the journal, balances, limits and upgrade hooks are real.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import test, { before, after } from "node:test";
import { idlFactory } from "../../packages/vfs-candid/index.ts";
const req = createRequire(realpathSync(createRequire(import.meta.url).resolve("@dfinity/pic")));
const { IDL } = req("@icp-sdk/core/candid");
const { Principal } = req("@icp-sdk/core/principal");
const { PocketIc, PocketIcServer } = req("@dfinity/pic");
if (process.env.POCKET_IC_BIN) PocketIcServer.getBinPath = () => process.env.POCKET_IC_BIN;
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(7));
const wikiId = Principal.fromText("6emaw-iyaaa-aaaay-aacka-cai");
const bekkoId = Principal.fromText("xrg4h-oiaaa-aaaal-qxrya-cai");
const proxyId = Principal.fromText("6dngc-faaaa-aaaay-aackq-cai");
const root = resolve(import.meta.dirname, "../..");
const wasm = name => resolve(root, "target", name);
const production = wasm("wasm32-unknown-unknown/release/vfs_canister.wasm");
const ok = result => { assert.ok("Ok" in result, JSON.stringify(result, (_, v) => typeof v === "bigint" ? String(v) : v)); return result.Ok; };
const topUp = IDL.Record({ enabled: IDL.Bool, threshold_cycles: IDL.Nat, launcher_principal: IDL.Text });
const billingType = IDL.Record({ kinic_ledger_canister_id: IDL.Text, billing_authority_id: IDL.Text,
  iap_authority_id: IDL.Opt(IDL.Text), cycles_per_kinic: IDL.Nat64, min_update_cycles: IDL.Nat64, top_up: topUp });
const billing = { kinic_ledger_canister_id: "aaaaa-aa", billing_authority_id: owner.toText(),
  iap_authority_id: [owner.toText()], cycles_per_kinic: 1000n, min_update_cycles: 1000000n,
  top_up: { enabled: false, threshold_cycles: 1000000000n, launcher_principal: "aaaaa-aa" } };
const config = { enabled: true, threshold_cycles: 20000000000000n, target_cycles: 21000000000000n,
  max_transfer_cycles: 600000000000n, max_daily_cycles: 1200000000000n, wiki_reserve_cycles: 4000000000000n };
const fixtureIdl = ({ IDL }) => IDL.Service({
  set_delays: IDL.Func([IDL.Bool, IDL.Bool], [], []),
  cycles_balance_for_wiki: IDL.Func([], [IDL.Variant({ Ok: IDL.Nat, Err: IDL.Text })], []),
});
let server;
before(async () => { server = await PocketIcServer.start(); });
after(async () => { await server?.stop(); });

async function setup(wikiWasm = production) {
  const pic = await PocketIc.create(server.getUrl());
  try {
    for (const id of [bekkoId, proxyId]) await pic.setupCanister({ targetCanisterId: id,
      sender: owner, controllers: [owner], cycles: 10000000000000n,
      idlFactory: fixtureIdl, wasm: wasm("bekko-refill-fault-fixture.wasm") });
    const { actor: wiki } = await pic.setupCanister({ targetCanisterId: wikiId, sender: owner,
      controllers: [owner], cycles: 30000000000000n, idlFactory, wasm: wikiWasm,
      arg: IDL.encode([billingType], [billing]) });
    wiki.setPrincipal(owner);
    await pic.tick(10); // Finish startup maintenance while refill is disabled.
    const bekko = pic.createActor(fixtureIdl, bekkoId); bekko.setPrincipal(owner);
    const proxy = pic.createActor(fixtureIdl, proxyId); proxy.setPrincipal(owner);
    const deferred = pic.createDeferredActor(idlFactory, wikiId); deferred.setPrincipal(owner);
    ok(await wiki.configure_bekko_refill(config));
    return { pic, wiki, bekko, proxy, deferred };
  } catch (error) { await pic.tearDown(); throw error; }
}
const stateOf = async wiki => ok(await wiki.get_bekko_refill_state());
async function until(pic, observe, predicate, description) {
  let value;
  for (let round = 0; round < 100; round++) {
    value = await observe();
    if (predicate(value)) return value;
    await pic.tick();
  }
  assert.fail(`Did not reach ${description}: ${JSON.stringify(value, (_, v) => typeof v === "bigint" ? String(v) : v)}`);
}
async function pendingHttp(pic) {
  return (await until(pic, () => pic.getPendingHttpsOutcalls(), calls => calls.length === 1, "held HTTP response"))[0];
}
async function release(pic, request) {
  await pic.mockPendingHttpsOutcall({ requestId: request.requestId, subnetId: request.subnetId,
    response: { type: "success", statusCode: 200, headers: [], body: new Uint8Array() } });
  await pic.tick(10);
}
const activeIs = name => state => state.active.length === 1 && name in state.active[0].outcome;
function assertOneReservation(state, id) {
  assert.equal(state.active[0].id, id);
  assert.equal(state.active[0].amount_cycles, 600000000000n);
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].amount_cycles, 600000000000n);
}
async function assertNoResend(pic, wiki, id, outcome) {
  const before = BigInt(await pic.getCyclesBalance(bekkoId));
  for (let repeat = 0; repeat < 3; repeat++) {
    const state = ok(await wiki.check_bekko_refill());
    assert.ok(activeIs(outcome)(state));
    assertOneReservation(state, id);
  }
  assert.ok(BigInt(await pic.getCyclesBalance(bekkoId)) <= before);
}
async function reconcileAndResume(pic, wiki, id) {
  assert.ok("Err" in await wiki.reconcile_bekko_refill(id, { Deposited: null }, "confirmed actual cycle movement"));
  ok(await wiki.configure_bekko_refill({ ...config, enabled: false }));
  wiki.setPrincipal(Principal.anonymous());
  assert.ok("Err" in await wiki.reconcile_bekko_refill(id, { Deposited: null }, "confirmed actual cycle movement"));
  wiki.setPrincipal(owner);
  assert.ok("Err" in await wiki.reconcile_bekko_refill(id + 1n, { Deposited: null }, "confirmed actual cycle movement"));
  assert.ok("Err" in await wiki.reconcile_bekko_refill(id, { Deposited: null }, ""));
  ok(await wiki.reconcile_bekko_refill(id, { Deposited: null }, "PocketIC actual Bekko cycle increase confirmed"));
  const resolved = await stateOf(wiki);
  assert.equal(resolved.active.length, 0);
  assert.equal(resolved.history.at(-1).outcome.Reconciled.deposited, true);
  assert.equal(resolved.reservations.length, 1);
  ok(await wiki.check_bekko_refill());
  assert.equal((await stateOf(wiki)).next_id, id); // Disabled never dispatches.
  ok(await wiki.configure_bekko_refill(config));
  const before = BigInt(await pic.getCyclesBalance(bekkoId));
  const resumed = ok(await wiki.check_bekko_refill());
  assert.ok("Succeeded" in resumed.history.at(-1).outcome);
  assert.equal(resumed.reservations.length, 2);
  assert.ok(BigInt(await pic.getCyclesBalance(bekkoId)) > before + 590000000000n);
  assert.ok("DailyLimit" in ok(await wiki.check_bekko_refill()).history.at(-1).outcome);
}

test("balance transport timeout sends no cycles and releases the read-only lock", { timeout: 120000 }, async () => {
  const { pic, wiki, bekko, deferred } = await setup();
  try {
    await bekko.set_delays(true, false);
    const before = BigInt(await pic.getCyclesBalance(bekkoId));
    const finish = await deferred.check_bekko_refill();
    const held = await pendingHttp(pic);
    const checking = await stateOf(wiki);
    assert.ok(activeIs("Checking")(checking));
    assert.equal(checking.reservations.length, 0);
    await pic.advanceTime(31000);
    await until(pic, () => stateOf(wiki), s => !s.active.length, "balance timeout completion");
    const failed = ok(await finish());
    assert.ok("Failed" in failed.history.at(-1).outcome);
    assert.equal(failed.history.at(-1).amount_cycles, 0n);
    assert.equal(failed.reservations.length, 0);
    assert.ok(BigInt(await pic.getCyclesBalance(bekkoId)) <= before);
    await release(pic, held); // Late read reply cannot cause a deposit.
    assert.equal((await stateOf(wiki)).reservations.length, 0);
    await bekko.set_delays(false, false);
    assert.ok("Succeeded" in ok(await wiki.check_bekko_refill()).history.at(-1).outcome);
  } finally { await pic.tearDown(); }
});

test("deposit response timeout stays Unknown after a late reply and resumes only after reconciliation", { timeout: 120000 }, async () => {
  const { pic, wiki, proxy, deferred } = await setup(wasm("bekko-refill-delayed.wasm"));
  try {
    await proxy.set_delays(false, true);
    const before = BigInt(await pic.getCyclesBalance(bekkoId));
    const finish = await deferred.check_bekko_refill();
    const held = await pendingHttp(pic); // Proxy holds only after real management deposit.
    assert.ok(BigInt(await pic.getCyclesBalance(bekkoId)) > before + 590000000000n);
    const id = (await stateOf(wiki)).active[0].id;
    await pic.advanceTime(31000);
    await until(pic, () => stateOf(wiki), activeIs("Unknown"), "deposit timeout lock");
    assert.ok(activeIs("Unknown")(ok(await finish())));
    await release(pic, held);
    await assertNoResend(pic, wiki, id, "Unknown");
    await proxy.set_delays(false, false);
    await reconcileAndResume(pic, wiki, id);
  } finally { await pic.tearDown(); }
});

test("callback trap preserves the deposit journal through upgrade and controller recovery", { timeout: 120000 }, async () => {
  const { pic, wiki } = await setup(wasm("bekko-refill-callback-trap.wasm"));
  try {
    const before = BigInt(await pic.getCyclesBalance(bekkoId));
    // The pinned DeferredActor wrapper does not propagate rejected awaitCall
    // promises. Use the public raw update API for an expected ingress rejection.
    await assert.rejects(pic.updateCall({ canisterId: wikiId, sender: owner,
      method: "check_bekko_refill", arg: IDL.encode([], []) }), /injected refill callback trap/);
    assert.ok(BigInt(await pic.getCyclesBalance(bekkoId)) > before + 590000000000n);
    const trapped = await stateOf(wiki);
    assert.ok(activeIs("Depositing")(trapped));
    const id = trapped.active[0].id;
    await assertNoResend(pic, wiki, id, "Depositing");
    ok(await wiki.configure_bekko_refill({ ...config, enabled: false }));
    assert.ok("Err" in await wiki.reconcile_bekko_refill(id, { Deposited: null }, "deposit confirmed"));
    await pic.upgradeCanister({ canisterId: wikiId, sender: owner, wasm: production });
    const recovered = await stateOf(wiki);
    assert.ok(activeIs("Unknown")(recovered));
    assertOneReservation(recovered, id);
    // Exercise the enabled gate before following the documented disabled recovery.
    ok(await wiki.configure_bekko_refill(config));
    await reconcileAndResume(pic, wiki, id);
  } finally { await pic.tearDown(); }
});

test("upgrade during an outstanding deposit keeps Unknown despite the old callback", { timeout: 120000 }, async () => {
  const { pic, wiki, proxy, deferred } = await setup(wasm("bekko-refill-delayed.wasm"));
  try {
    await proxy.set_delays(false, true);
    const before = BigInt(await pic.getCyclesBalance(bekkoId));
    await deferred.check_bekko_refill(); // Old ingress is deliberately abandoned across upgrade.
    const held = await pendingHttp(pic);
    assert.ok(BigInt(await pic.getCyclesBalance(bekkoId)) > before + 590000000000n);
    const pending = await stateOf(wiki);
    assert.ok(activeIs("Depositing")(pending));
    const id = pending.active[0].id;
    await pic.upgradeCanister({ canisterId: wikiId, sender: owner, wasm: production });
    assert.ok(activeIs("Unknown")(await stateOf(wiki)));
    await release(pic, held);
    await assertNoResend(pic, wiki, id, "Unknown");
    await reconcileAndResume(pic, wiki, id);
  } finally { await pic.tearDown(); }
});

// Removing the Unknown lock must not turn the daily timer into an automatic retry.
test("Unknown deposit remains locked after daily budget expiry and config edits", { timeout: 120000 }, async () => {
  const { pic, wiki, proxy, deferred } = await setup(wasm("bekko-refill-delayed.wasm"));
  try {
    const databaseId = ok(await wiki.create_database({ name: "daily lock continuity" })).database_id;
    const chargedAt = async () => {
      const result = ok(await wiki.query_index_sql_json(
        `SELECT json_object('charged', storage_charged_at_ms) FROM database_cycle_accounts WHERE database_id = '${databaseId}'`, 1));
      return JSON.parse(result.rows[0]).charged;
    };
    const chargedBefore = await chargedAt();
    await proxy.set_delays(false, true);
    const finish = await deferred.check_bekko_refill();
    const held = await pendingHttp(pic);
    const id = (await stateOf(wiki)).active[0].id;
    await pic.advanceTime(31000);
    await until(pic, () => stateOf(wiki), activeIs("Unknown"), "deposit timeout lock");
    assert.ok(activeIs("Unknown")(ok(await finish())));
    await release(pic, held);
    const before = BigInt(await pic.getCyclesBalance(bekkoId));
    await pic.advanceTime(86400001);
    await pic.tick(50); // Execute the actual daily timer, with the old budget now expired.
    assert.ok(await chargedAt() > chargedBefore, "daily maintenance must actually bill storage");
    assert.ok(BigInt(await pic.getCyclesBalance(bekkoId)) <= before);
    ok(await wiki.configure_bekko_refill({ ...config, enabled: false }));
    ok(await wiki.configure_bekko_refill(config));
    await assertNoResend(pic, wiki, id, "Unknown");
  } finally { await pic.tearDown(); }
});
