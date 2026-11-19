import { startVaultPocketIc } from "../helpers/vault-pocketic-server.mjs";
// Actual Wasm current schema14 capacity and payment continuity with a separate synthetic ledger.
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
const server = await startVaultPocketIc(PocketIcServer.getBinPath());
let pic;
try {
  pic = await PocketIc.create(server.getUrl());
  const wasm = resolve(
    root,
    "target/vault-synthetic-funding-build/wasm32-unknown-unknown/release/vault_canister.wasm",
  );
  const baseline = resolve(root, "target/vault-ii-acceptance/vault-state.wasm");
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
  const setupFakeLedger = () => pic.setupCanister({
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
  const fake = await setupFakeLedger();
  fake.actor.setPrincipal(owner);
  const setup = async (count) => {
    const v = await pic.setupCanister({
      sender: owner,
      idlFactory,
      wasm: baseline,
      arg: IDL.encode([], []),
      cycles: 100_000_000_000_000n,
    });
    v.actor.setPrincipal(owner);
    const control = pic.createActor(
      () => IDL.Service({ fixture_execute: IDL.Func([IDL.Text], [], []) }),
      v.canisterId,
    );
    control.setPrincipal(owner);
    await control.fixture_execute(
      Array.from(
        { length: count },
        (_, n) => `INSERT INTO accounts(owner,balance_cycles,storage_bytes,storage_charged_at_ms,storage_charge_remainder) VALUES('${p(n).toText()}',1,0,0,0);`,
      ).join("\n"),
    );
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
  assert.equal(initial.limit, (1n << 64n) - 1n);
  assert.equal(initial.overcommitted, false);
  assert.equal(initial.overage, 0n);
  assert.ok(initial.accounting_reserved >= 64n * 1024n);
  assert.ok(initial.used >= initial.accounting_reserved);
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
  const secondActor = pic.createDeferredActor(idlFactory, v.canisterId);
  secondActor.setPrincipal(p(3001));
  const second = await secondActor.pay_purchase(b.operation);
  await until(async () => (await fake.actor.calls()).length === 2);
  const thirdActor = pic.createDeferredActor(idlFactory, v.canisterId);
  thirdActor.setPrincipal(p(3002));
  const third = await thirdActor.pay_purchase(same.operation);
  await until(async () => (await fake.actor.calls()).length === 3);
  await until(async () => (await pic.getPendingHttpsOutcalls()).length === 3);
  const held = await pic.getPendingHttpsOutcalls();
  assert.equal(held.length, 3);
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
  assert.ok("Paid" in ok(await third()).status);
  v.actor.setPrincipal(p(2000));
  assert.equal(ok(await v.actor.account_balance()), 2_000_000_000n);
  v.actor.setPrincipal(p(2001));
  assert.equal(ok(await v.actor.account_balance()), 1_000_000_000n);
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
    "PASS actual Wasm: another beneficiary receives credit after the former account cap; concurrent same-beneficiary credits settle; oversized GenericError persists only bounded typed receipt.",
  );
  await fake.actor.configure(6, 10n);
  const pending = await quote(v, p(3101), p(0), 11);
  assert.ok(
    "Unknown" in ok(await v.actor.pay_purchase(pending.operation)).status,
  );
  const beforeUpgrade = ok(await v.actor.payment_status(pending.operation))[0];
  v.actor.setPrincipal(p(0));
  const balanceBefore = ok(await v.actor.account_balance());
  await upgrade(v);
  v.actor.setPrincipal(p(3101));
  assert.deepEqual(
    ok(await v.actor.payment_status(pending.operation))[0],
    beforeUpgrade,
  );
  await fake.actor.configure(4, 10n);
  assert.ok("Paid" in ok(await v.actor.pay_purchase(pending.operation)).status);
  const last = (await fake.actor.calls()).slice(-2);
  assert.deepEqual(last[0], last[1]);
  v.actor.setPrincipal(p(0));
  assert.equal(
    ok(await v.actor.account_balance()),
    balanceBefore + 1_000_000_000n,
  );
  console.log(
    "PASS current schema14: exact Unknown payment and balances survive upgrade, same transfer bytes settle once",
  );

  // The state-control fixture runs the current Rust code and pinned SQLite VFS.
  // Its write connection remains open across messages, so max_page_count can
  // emulate a database that cannot allocate another SQLite page.
  const limited = await setup(0);
  await configure(limited);
  await fake.actor.configure(6, 10n);
  const limitedPayment = await quote(limited, p(3201), p(3202), 12);
  assert.ok(
    "Unknown" in ok(await limited.actor.pay_purchase(limitedPayment.operation)).status,
  );
  const controls = pic.createActor(
    () =>
      IDL.Service({
        fixture_execute: IDL.Func([IDL.Text], [], []),
        fixture_read_update: IDL.Func([IDL.Text], [IDL.Text], []),
      }),
    limited.canisterId,
  );
  controls.setPrincipal(owner);
  const readNumber = async (sql) =>
    BigInt(await controls.fixture_read_update(`SELECT CAST((${sql}) AS TEXT)`));
  const pages = await readNumber("SELECT page_count FROM pragma_page_count");
  assert.equal(
    await readNumber("SELECT count(*) FROM payment_completion_reservations"),
    1n,
  );
  await controls.fixture_execute(`PRAGMA max_page_count=${pages};`);
  assert.equal(
    await readNumber("SELECT max_page_count FROM pragma_max_page_count"),
    pages,
  );
  await fake.actor.configure(4, 10n);
  limited.actor.setPrincipal(p(3201));
  assert.ok(
    "Paid" in ok(await limited.actor.pay_purchase(limitedPayment.operation)).status,
  );
  assert.equal(
    await readNumber("SELECT max_page_count FROM pragma_max_page_count"),
    pages,
    "the SQLite page bound must remain active through settlement",
  );
  assert.equal(await readNumber("SELECT page_count FROM pragma_page_count"), pages);
  assert.equal(
    await readNumber("SELECT count(*) FROM payment_completion_reservations"),
    0n,
  );
  const transferCalls = (await fake.actor.calls()).length;
  assert.deepEqual(await limited.actor.pay_purchase(limitedPayment.operation), {
    Err: { Conflict: null },
  });
  assert.equal((await fake.actor.calls()).length, transferCalls);
  limited.actor.setPrincipal(p(3202));
  assert.equal(ok(await limited.actor.account_balance()), 1_000_000_000n);
  console.log(
    "PASS actual Wasm SQLite page ceiling: Unknown settles once with no new SQLite pages after releasing its completion reserve",
  );

  // Exercise real stable-memory growth across many independent wallets. These
  // payments are deliberately Unknown until the test reconciles each one.
  const pressure = await setup(0);
  await configure(pressure);
  const pressureControls = pic.createActor(
    () => IDL.Service({ fixture_read_update: IDL.Func([IDL.Text], [IDL.Text], []) }),
    pressure.canisterId,
  );
  pressureControls.setPrincipal(owner);
  const pressureRead = async (sql) =>
    BigInt(await pressureControls.fixture_read_update(`SELECT CAST((${sql}) AS TEXT)`));
  const beforeStatus = await pic.canisterStatus({
    canisterId: pressure.canisterId,
    sender: owner,
  });
  const beforePages = await pressureRead("SELECT page_count FROM pragma_page_count");
  const pressurePayments = [];
  await fake.actor.configure(6, 10n);
  for (let n = 0; n < 24; n++) {
    const wallet = p(5000 + n);
    const payment = await quote(pressure, wallet, p(6000 + n), 32 + n);
    assert.ok("Unknown" in ok(await pressure.actor.pay_purchase(payment.operation)).status);
    pressurePayments.push({ wallet, payment });
  }
  const heldReserves = await pressureRead(
    "SELECT count(*) FROM payment_completion_reservations",
  );
  const afterPages = await pressureRead("SELECT page_count FROM pragma_page_count");
  const afterStatus = await pic.canisterStatus({
    canisterId: pressure.canisterId,
    sender: owner,
  });
  assert.equal(heldReserves, 24n);
  assert.ok(afterPages > beforePages + 1_100n);
  assert.ok(afterStatus.memorySize > beforeStatus.memorySize + 18n * 1024n * 1024n);
  assert.ok(beforeStatus.cycles > afterStatus.cycles);
  await fake.actor.configure(4, 10n);
  for (const { wallet, payment } of pressurePayments) {
    pressure.actor.setPrincipal(wallet);
    const settled = ok(await pressure.actor.pay_purchase(payment.operation));
    assert.ok("Paid" in settled.status, JSON.stringify(settled, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ));
  }
  assert.equal(
    await pressureRead("SELECT count(*) FROM payment_completion_reservations"),
    0n,
  );
  const settledStatus = await pic.canisterStatus({
    canisterId: pressure.canisterId,
    sender: owner,
  });
  assert.ok(settledStatus.memorySize >= afterStatus.memorySize);
  console.log(
    `PASS actual Wasm stable-memory pressure: 24 Unknown payments grew canister memory by ${afterStatus.memorySize - beforeStatus.memorySize} bytes and held ${afterPages - beforePages} SQLite pages, consumed ${beforeStatus.cycles - afterStatus.cycles} cycles; all 24 settled once, retained memory ${settledStatus.memorySize - beforeStatus.memorySize} bytes above baseline`,
  );
  const secondLedger = await setupFakeLedger();
  secondLedger.actor.setPrincipal(owner);
  pressure.actor.setPrincipal(owner);
  ok(await pressure.actor.set_funding_config([{
    ledger: secondLedger.canisterId,
    recipient: pressure.canisterId,
    cycles_per_kinic: 1_000_000_000n,
  }]));
  await secondLedger.actor.configure(6, 10n);
  const secondWave = [];
  for (let n = 0; n < 24; n++) {
    const wallet = p(7000 + n);
    const payment = await quote(pressure, wallet, p(8000 + n), 64 + n);
    assert.ok("Unknown" in ok(await pressure.actor.pay_purchase(payment.operation)).status);
    secondWave.push({ wallet, payment });
  }
  const secondWaveStatus = await pic.canisterStatus({
    canisterId: pressure.canisterId,
    sender: owner,
  });
  const secondWavePages = await pressureRead("SELECT page_count FROM pragma_page_count");
  assert.equal(await pressureRead("SELECT count(*) FROM payment_completion_reservations"), 24n);
  assert.ok(secondWaveStatus.memorySize <= settledStatus.memorySize + 2n * 1024n * 1024n);
  assert.ok(secondWavePages <= afterPages + 128n);
  await secondLedger.actor.configure(4, 10n);
  for (const { wallet, payment } of secondWave) {
    pressure.actor.setPrincipal(wallet);
    assert.ok("Paid" in ok(await pressure.actor.pay_purchase(payment.operation)).status);
  }
  assert.equal(await pressureRead("SELECT count(*) FROM payment_completion_reservations"), 0n);
  const secondSettledStatus = await pic.canisterStatus({
    canisterId: pressure.canisterId,
    sender: owner,
  });
  assert.ok(secondSettledStatus.memorySize <= settledStatus.memorySize + 2n * 1024n * 1024n);
  console.log(
    `PASS actual Wasm stable-memory reuse: second 24-payment wave grew canister memory by ${secondWaveStatus.memorySize - settledStatus.memorySize} bytes and SQLite file by ${secondWavePages - afterPages} pages before all settled`,
  );

  const frozenLedger = await setupFakeLedger();
  frozenLedger.actor.setPrincipal(owner);
  const frozen = await setup(0);
  frozen.actor.setPrincipal(owner);
  ok(await frozen.actor.set_funding_config([{
    ledger: frozenLedger.canisterId,
    recipient: frozen.canisterId,
    cycles_per_kinic: 1_000_000_000n,
  }]));
  await frozenLedger.actor.configure(8, 10n);
  const freezePayment = await quote(frozen, p(9001), p(9002), 100);
  const freezeActor = pic.createDeferredActor(idlFactory, frozen.canisterId);
  freezeActor.setPrincipal(p(9001));
  const awaitPayment = await freezeActor.pay_purchase(freezePayment.operation);
  await until(async () => (await frozenLedger.actor.calls()).length === 1);
  await until(async () => (await pic.getPendingHttpsOutcalls()).length === 1);
  const frozenStatus = await pic.canisterStatus({ canisterId: frozen.canisterId, sender: owner });
  const threshold = frozenStatus.cycles * 86_400n / frozenStatus.idleCyclesBurnedPerDay + 86_400n;
  await pic.updateCanisterSettings({
    canisterId: frozen.canisterId,
    sender: owner,
    freezingThreshold: threshold,
  });
  assert.ok(threshold * frozenStatus.idleCyclesBurnedPerDay / 86_400n > frozenStatus.cycles);
  await assert.rejects(
    pic.canisterStatus({ canisterId: frozen.canisterId, sender: owner }),
    /CanisterOutOfCycles/,
  );
  const pendingOutcall = (await pic.getPendingHttpsOutcalls())[0];
  await pic.mockPendingHttpsOutcall({
    requestId: pendingOutcall.requestId,
    subnetId: pendingOutcall.subnetId,
    response: { type: "success", statusCode: 200, headers: [], body: new Uint8Array() },
  });
  await pic.tick(10);
  const whileFrozen = await Promise.race([
    awaitPayment().then(
      (result) => ({ kind: "completed", result }),
      (error) => ({ kind: "rejected", error: String(error) }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "pending" }), 1_000)),
  ]);
  assert.equal(whileFrozen.kind, "completed");
  assert.ok("Paid" in ok(whileFrozen.result).status);
  await pic.updateCanisterSettings({ canisterId: frozen.canisterId, sender: owner, freezingThreshold: 0n });
  await pic.tick(10);
  assert.equal((await frozenLedger.actor.calls()).length, 1);
  frozen.actor.setPrincipal(p(9002));
  assert.equal(ok(await frozen.actor.account_balance()), 1_000_000_000n);
  console.log("PASS actual Wasm low-cycle callback: a frozen Vault rejected management status but completed the in-flight ledger response once before unfreezing");
} finally {
  try {
    if (pic) await pic.tearDown();
  } finally {
    await server.stop();
  }
}
