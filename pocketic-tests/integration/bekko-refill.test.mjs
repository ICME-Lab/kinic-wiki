// Cross-repository rehearsal: requires the linked Bekko PR Wasm and its pinned compact pack.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
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
const wikiWasm = resolve(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/vfs_canister.wasm");
const required = (key) => { assert.ok(process.env[key], `${key} is required`); return process.env[key]; };
const ok = (value) => { assert.ok("Ok" in value, JSON.stringify(value, (_, v) => typeof v === "bigint" ? String(v) : v)); return value.Ok; };
const topUpType = IDL.Record({ enabled: IDL.Bool, threshold_cycles: IDL.Nat, launcher_principal: IDL.Text });
const configType = IDL.Record({ kinic_ledger_canister_id: IDL.Text, billing_authority_id: IDL.Text,
  iap_authority_id: IDL.Opt(IDL.Text), cycles_per_kinic: IDL.Nat64, min_update_cycles: IDL.Nat64, top_up: topUpType });
let server;
before(async () => { server = await PocketIcServer.start(); });
after(async () => { await server?.stop(); });
const billing = { kinic_ledger_canister_id: "aaaaa-aa", billing_authority_id: owner.toText(),
  iap_authority_id: [owner.toText()], cycles_per_kinic: 1000n, min_update_cycles: 1000000n,
  top_up: { enabled: false, threshold_cycles: 1000000000n, launcher_principal: "aaaaa-aa" } };
const refill = { enabled: true, threshold_cycles: 20000000000000n, target_cycles: 21000000000000n,
  max_transfer_cycles: 600000000000n, max_daily_cycles: 1200000000000n, wiki_reserve_cycles: 4000000000000n };
const unitResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
const natResult = IDL.Variant({ Ok: IDL.Nat, Err: IDL.Text });
const bekkoFactory = ({ IDL }) => IDL.Service({
  upload: IDL.Func([IDL.Nat64, IDL.Vec(IDL.Nat8)], [IDL.Variant({ Ok: IDL.Nat64, Err: IDL.Text })], []),
  activate: IDL.Func([], [unitResult], []),
  cycles_balance_for_wiki: IDL.Func([], [natResult], []),
  modelInfo: IDL.Func([], [IDL.Record({ embedding_space: IDL.Text, runtime_id: IDL.Text,
    weights_verified: IDL.Bool, active: IDL.Bool, weight_pack_sha256: IDL.Text, uploaded_bytes: IDL.Nat64 })], ["query"]),
  embed: IDL.Func([IDL.Vec(IDL.Nat32)], [IDL.Variant({ Err: IDL.Text, Ok: IDL.Record({ embedding: IDL.Vec(IDL.Float32), embedding_space: IDL.Text }) })], ["query"]),
});
async function createWiki(pic) {
  const { actor } = await pic.setupCanister({ targetCanisterId: wikiId, sender: owner,
    controllers: [owner], cycles: 30000000000000n, idlFactory, wasm: wikiWasm,
    arg: IDL.encode([configType], [billing]) });
  actor.setPrincipal(owner); return actor;
}

test("real deposit, authorization, compact-model upgrade, and persistent daily budget", { timeout: 600000 }, async () => {
  const oldWasm = required("BEKKO_BASELINE_WASM");
  const newWasm = required("BEKKO_REFILL_WASM");
  const pack = readFileSync(required("BEKKO_COMPACT_PACK"));
  // Compiling the compact model and verifying its pack can exceed the client's
  // default 30 seconds. Keep this host wait separate from canister call deadlines.
  const pic = await PocketIc.create(server.getUrl(), { processingTimeoutMs: 120000 });
  try {
    const { actor: bekko } = await pic.setupCanister({ targetCanisterId: bekkoId, sender: owner,
      controllers: [owner], cycles: 10000000000000n, idlFactory: bekkoFactory, wasm: oldWasm });
    bekko.setPrincipal(owner);
    const packHash = createHash("sha256").update(pack).digest("hex");
    assert.equal((await bekko.modelInfo()).weight_pack_sha256, packHash);
    for (let offset = 0; offset < pack.length; offset += 1800000) {
      assert.equal(ok(await bekko.upload(BigInt(offset), pack.subarray(offset, offset + 1800000))), BigInt(Math.min(offset + 1800000, pack.length)));
    }
    ok(await bekko.activate());
    const ids = [2, 4, 7, 16, 32, 64, 128, 256, 3, 9, 24, 48, 96, 192].map((length, index) =>
      [2, ...Array.from({ length: length - 2 }, (_, i) => 3 + ((i * 31 + index * 17) % 10000)), 1]);
    const before = [];
    for (const tokens of ids) before.push(ok(await bekko.embed(tokens)));
    const modelBefore = await bekko.modelInfo();
    await pic.upgradeCanister({ canisterId: bekkoId, sender: owner, wasm: newWasm });
    const upgraded = await bekko.modelInfo();
    assert.equal(upgraded.weights_verified, true); assert.equal(upgraded.active, false);
    for (const key of ["embedding_space", "runtime_id", "weight_pack_sha256", "uploaded_bytes"]) assert.deepEqual(upgraded[key], modelBefore[key]);
    ok(await bekko.activate());
    for (let i = 0; i < ids.length; i++) assert.deepEqual(ok(await bekko.embed(ids[i])), before[i]);
    bekko.setPrincipal(Principal.anonymous()); assert.ok("Err" in await bekko.cycles_balance_for_wiki());
    bekko.setPrincipal(owner); assert.ok("Err" in await bekko.cycles_balance_for_wiki());
    bekko.setPrincipal(wikiId); assert.ok(ok(await bekko.cycles_balance_for_wiki()) > 0n);
    const wiki = await createWiki(pic);
    assert.equal(ok(await wiki.get_bekko_refill_state()).config.enabled, false);
    wiki.setPrincipal(Principal.anonymous());
    assert.ok("Err" in await wiki.configure_bekko_refill(refill));
    assert.ok("Err" in await wiki.check_bekko_refill());
    assert.ok("Err" in await wiki.get_bekko_refill_state());
    assert.ok("Err" in await wiki.periodic_storage_billing());
    assert.ok("Err" in await wiki.periodic_cycles_refill());
    wiki.setPrincipal(owner); ok(await wiki.configure_bekko_refill(refill));
    const beforeBekko = BigInt(await pic.getCyclesBalance(bekkoId));
    const beforeWiki = BigInt(await pic.getCyclesBalance(wikiId));
    const state = ok(await wiki.check_bekko_refill());
    assert.ok("Succeeded" in state.history.at(-1).outcome);
    assert.equal(state.history.at(-1).amount_cycles, 600000000000n);
    assert.ok(BigInt(await pic.getCyclesBalance(bekkoId)) > beforeBekko + 590000000000n);
    assert.ok(BigInt(await pic.getCyclesBalance(wikiId)) < beforeWiki - 600000000000n);
    await pic.upgradeCanister({ canisterId: wikiId, sender: owner, wasm: wikiWasm });
    await pic.tick(30); // Startup check may consume the second half of the 24h budget.
    let afterUpgrade = ok(await wiki.get_bekko_refill_state());
    assert.equal(afterUpgrade.config.enabled, true);
    assert.ok(afterUpgrade.reservations.length >= 1);
    let latest = ok(await wiki.check_bekko_refill());
    if (!("DailyLimit" in latest.history.at(-1).outcome)) latest = ok(await wiki.check_bekko_refill());
    assert.ok("DailyLimit" in latest.history.at(-1).outcome);
    assert.equal(latest.reservations.reduce((n, r) => n + r.amount_cycles, 0n), 1200000000000n);
    // Disablement/config edits do not reset the budget.
    ok(await wiki.configure_bekko_refill({ ...refill, enabled: false }));
    ok(await wiki.configure_bekko_refill(refill));
    assert.ok("DailyLimit" in ok(await wiki.check_bekko_refill()).history.at(-1).outcome);
    // A frozen Bekko cannot execute the balance update: no deposit is attempted.
    await pic.updateCanisterSettings({ canisterId: bekkoId, sender: owner, freezingThreshold: 4294967295n });
    const failed = ok(await wiki.check_bekko_refill());
    assert.ok("Failed" in failed.history.at(-1).outcome);
    assert.equal(failed.history.at(-1).amount_cycles, 0n);
    console.log("14 compact embeddings identical; Wiki->Bekko execution cycles increased; upgrade retained daily cap; frozen read sent nothing");
  } finally { await pic.tearDown(); }
});

test("daily billing continues when both self-refill and Bekko calls fail", { timeout: 120000 }, async () => {
  const pic = await PocketIc.create(server.getUrl());
  try {
    const wiki = await createWiki(pic);
    const db = ok(await wiki.create_database({ name: "billing continuity" })).database_id;
    ok(await wiki.configure_bekko_refill(refill));
    ok(await wiki.update_cycles_billing_config({ iap_authority_id: [owner.toText()],
      cycles_per_kinic: 1000n, min_update_cycles: 1000000n,
      top_up: { enabled: true, threshold_cycles: 100000000000000n, launcher_principal: "aaaaa-aa" } }));
    await pic.advanceTime(86400001); await pic.tick(50);
    const state = ok(await wiki.get_bekko_refill_state());
    assert.ok(state.history.some((a) => "Failed" in a.outcome));
    const rows = ok(await wiki.query_index_sql_json(`SELECT json_object('charged', storage_charged_at_ms) FROM database_cycle_accounts WHERE database_id = '${db}'`, 1));
    assert.ok(JSON.parse(rows.rows[0]).charged > 0);
  } finally { await pic.tearDown(); }
});

test("liquid balance cap retains the real prepaid deposit-call cost", { timeout: 120000 }, async () => {
  const pic = await PocketIc.create(server.getUrl());
  try {
    await pic.setupCanister({ targetCanisterId: bekkoId, sender: owner, controllers: [owner],
      cycles: 10000000000000n, idlFactory: bekkoFactory, wasm: required("BEKKO_REFILL_WASM") });
    const wiki = await createWiki(pic);
    ok(await wiki.configure_bekko_refill({ enabled: true, threshold_cycles: 99000000000000n,
      target_cycles: 100000000000000n, max_transfer_cycles: 30000000000000n,
      max_daily_cycles: 60000000000000n, wiki_reserve_cycles: 1000000000n }));
    const before = BigInt(await pic.getCyclesBalance(bekkoId));
    const result = ok(await wiki.check_bekko_refill());
    assert.ok("Succeeded" in result.history.at(-1).outcome,
      JSON.stringify(result.history.at(-1), (_, v) => typeof v === "bigint" ? String(v) : v));
    assert.ok(BigInt(await pic.getCyclesBalance(bekkoId)) > before + 20000000000000n);
  } finally { await pic.tearDown(); }
});
