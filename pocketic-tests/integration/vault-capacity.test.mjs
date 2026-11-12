import { startVaultPocketIc } from "../helpers/vault-pocketic-server.mjs";
// Actual Wasm current v6 capacity and payment continuity with a separate synthetic ledger.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { idlFactory } from "../../packages/vault-candid/index.js";
const root = resolve(import.meta.dirname, "../..");
const local = createRequire(new URL("../package.json", import.meta.url));
const require = createRequire(realpathSync(local.resolve("@dfinity/pic")));
const { PocketIc, PocketIcServer } = require("@dfinity/pic"),
  { IDL } = require("@icp-sdk/core/candid"),
  { Principal } = require("@icp-sdk/core/principal");
if (process.env.POCKET_IC_BIN)
  PocketIcServer.getBinPath = () => process.env.POCKET_IC_BIN;
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(90));
const p = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return Principal.selfAuthenticating(b);
};
const ok = (r) => {
  assert.ok(
    "Ok" in r,
    JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
  return r.Ok;
};
const capacityError = (r) =>
  assert.deepEqual(r, { Err: { QuotaExceeded: null } });
const server = await startVaultPocketIc(PocketIcServer.getBinPath());
let pic;
try {
  pic = await PocketIc.create(server.getUrl());
  const wasm = resolve(
    root,
    "target/vault-synthetic-funding-build/wasm32-unknown-unknown/release/vault_canister.wasm",
  );
  const baseline = resolve(root, "target/vault-capacity-baseline.wasm");
  const account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const transfer = IDL.Record({
    spender_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
    from: account,
    to: account,
    amount: IDL.Nat,
    fee: IDL.Opt(IDL.Nat),
    memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
    created_at_time: IDL.Opt(IDL.Nat64),
  });
  const fake = await pic.setupCanister({
    sender: owner,
    idlFactory: () =>
      IDL.Service({
        configure: IDL.Func([IDL.Nat8, IDL.Nat64], [], []),
        calls: IDL.Func([], [IDL.Vec(transfer)], ["query"]),
      }),
    wasm: resolve(
      root,
      "target/wasm32-unknown-unknown/release/vault_ledger_fixture.wasm",
    ),
    arg: IDL.encode([], []),
    cycles: 100_000_000_000_000n,
  });
  fake.actor.setPrincipal(owner);
  const setup = async (count) => {
    const v = await pic.setupCanister({
      sender: owner,
      idlFactory,
      wasm: baseline,
      arg: IDL.encode([IDL.Nat16], [count]),
      cycles: 100_000_000_000_000n,
    });
    v.actor.setPrincipal(owner);
    return v;
  };
  const upgrade = async (v, path = wasm) => {
    // PocketIC 16.1: an application install uses at most 300B instructions,
    // and its install-code debit drains by 2B per scheduler round. Drain the
    // full budget without aging quotes, billing, or retained export snapshots.
    const before = await pic.getTime();
    await pic.tick(150);
    assert.ok(
      (await pic.getTime()) - before < 1,
      "install-code budget pacing advanced the financial clock",
    );
    return pic.upgradeCanister({
      sender: owner,
      canisterId: v.canisterId,
      wasm: path,
      arg: IDL.encode([], []),
    });
  };
  const configure = async (v) =>
    ok(
      await v.actor.set_funding_config([
        {
          ledger: fake.canisterId,
          recipient: v.canisterId,
          cycles_per_kinic: 1_000_000_000n,
        },
      ]),
    );
  const quote = async (v, wallet, beneficiary, id) => {
    v.actor.setPrincipal(wallet);
    const r = {
      operation: new Uint8Array(16).fill(id),
      beneficiary,
      amount_e8s: 100_000_000n,
      min_credits: 1_000_000_000n,
      created_at_time: BigInt(await pic.getTime()) * 1_000_000n,
    };
    ok(await v.actor.quote_purchase(r));
    return r;
  };
  const v = await setup(1023);
  await upgrade(v);
  await configure(v);
  const initial = ok(await v.actor.global_capacity());
  assert.equal(initial.accounting_reserved, 16n * 1024n * 1024n);
  assert.equal(initial.limit, 200n * 1024n * 1024n);
  assert.equal(initial.overcommitted, false);
  assert.equal(initial.legacy_excess, 0n);
  const a = await quote(v, p(3000), p(2000), 1),
    b = await quote(v, p(3001), p(2001), 2),
    same = await quote(v, p(3002), p(2000), 3);
  await fake.actor.configure(8, 10n);
  const deferred = pic.createDeferredActor(idlFactory, v.canisterId);
  deferred.setPrincipal(p(3000));
  const first = await deferred.pay_purchase(a.operation);
  const until = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await pic.tick();
    }
    assert.fail("transfer did not reach ledger");
  };
  await until(async () => (await fake.actor.calls()).length === 1);
  v.actor.setPrincipal(p(3001));
  capacityError(await v.actor.pay_purchase(b.operation));
  assert.equal(
    (await fake.actor.calls()).length,
    1,
    "capacity rejection reached ledger",
  );
  const secondActor = pic.createDeferredActor(idlFactory, v.canisterId);
  secondActor.setPrincipal(p(3002));
  const second = await secondActor.pay_purchase(same.operation);
  await until(async () => (await fake.actor.calls()).length === 2);
  await until(async () => (await pic.getPendingHttpsOutcalls()).length === 2);
  const held = await pic.getPendingHttpsOutcalls();
  assert.equal(held.length, 2);
  for (const outcall of held)
    await pic.mockPendingHttpsOutcall({
      requestId: outcall.requestId,
      subnetId: outcall.subnetId,
      response: {
        type: "success",
        statusCode: 200,
        headers: [],
        body: new Uint8Array(),
      },
    });
  assert.ok("Paid" in ok(await first()).status);
  assert.ok("Paid" in ok(await second()).status);
  v.actor.setPrincipal(p(2000));
  assert.equal(ok(await v.actor.account_balance()), 2_000_000_000n);
  await fake.actor.configure(0, 10n);
  const top = await quote(v, p(3003), p(0), 4);
  assert.ok("Paid" in ok(await v.actor.pay_purchase(top.operation)).status);
  await fake.actor.configure(7, 10n);
  const error = await quote(v, p(3004), p(0), 5);
  const rejected = ok(await v.actor.pay_purchase(error.operation));
  assert.deepEqual(rejected.status, { Rejected: null });
  assert.ok(
    JSON.stringify(rejected, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ).length < 4096,
  );
  console.log(
    "PASS actual Wasm: last-slot distinct beneficiary rejected before ledger; concurrent same beneficiary shares slot; existing-account topup at cap; oversized GenericError persists only bounded typed receipt.",
  );
  await fake.actor.configure(6, 10n);
  const pending = await quote(v, p(3101), p(0), 11);
  assert.ok("Unknown" in ok(await v.actor.pay_purchase(pending.operation)).status);
  const beforeUpgrade = ok(await v.actor.payment_status(pending.operation))[0];
  v.actor.setPrincipal(p(0));
  const balanceBefore = ok(await v.actor.account_balance());
  await upgrade(v);
  v.actor.setPrincipal(p(3101));
  assert.deepEqual(ok(await v.actor.payment_status(pending.operation))[0], beforeUpgrade);
  await fake.actor.configure(4, 10n);
  assert.ok("Paid" in ok(await v.actor.pay_purchase(pending.operation)).status);
  const last = (await fake.actor.calls()).slice(-2);
  assert.deepEqual(last[0], last[1]);
  v.actor.setPrincipal(p(0));
  assert.equal(ok(await v.actor.account_balance()), balanceBefore + 1_000_000_000n);
  console.log("PASS current v6: exact Unknown payment and balances survive upgrade, same transfer bytes settle once at the account cap");

} finally {
  if (pic) await pic.tearDown();
  await server.stop();
}
