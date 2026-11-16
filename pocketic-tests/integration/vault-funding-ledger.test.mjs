// Actual pinned DFINITY ledger + its embedded archive, with a NONDEPLOYABLE
// Vault that can discard one post-await response. No history/credit is injected.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { startVaultPocketIc } from "../helpers/vault-pocketic-server.mjs";
import { idlFactory } from "../../target/vault-funding-fault/vault-candid.mjs";
const require = createRequire(import.meta.url),
  sdk = createRequire(realpathSync(require.resolve("@dfinity/pic")));
const { IDL } = sdk("@icp-sdk/core/candid"),
  { Principal } = sdk("@icp-sdk/core/principal"),
  { PocketIc } = require("@dfinity/pic");
const root = resolve(import.meta.dirname, "../..");
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(90)),
  other = Principal.selfAuthenticating(new Uint8Array(32).fill(91));
const ok = (r) => {
  assert.ok(
    "Ok" in r,
    JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v)),
  );
  return r.Ok;
};
let counter = 0;
const operation = () => {
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(12, ++counter);
  return bytes;
};
import { ledgerTypes } from "../helpers/official-icrc-ledger.mjs";
const wasm = resolve(
  root,
  "target/vault-funding-fault/build/wasm32-unknown-unknown/release/vault_canister.wasm",
);
assert.ok(
  process.env.POCKET_IC_BIN,
  "POCKET_IC_BIN must identify PocketIC16.1.0",
);
const pocketIcVersion = execFileSync(process.env.POCKET_IC_BIN, ["--version"], {
  encoding: "utf8",
}).trim();
assert.equal(
  pocketIcVersion,
  "pocket-ic-server 16.1.0",
  "Official ledger acceptance requires the verified PocketIC version",
);
console.log(`Runtime: ${pocketIcVersion}`);
const server = await startVaultPocketIc(process.env.POCKET_IC_BIN);
let pic;
try {
  pic = await PocketIc.create(server.getUrl());
  await pic.setTime(Date.now());
  const vault = await pic.setupCanister({
    sender: owner,
    idlFactory,
    wasm,
    cycles: 100_000_000_000_000n,
  });
  vault.actor.setPrincipal(owner);
  const f = {
    ...vault,
    pic,
    upgrade: () =>
      pic.upgradeCanister({
        sender: owner,
        canisterId: vault.canisterId,
        wasm,
        arg: IDL.encode([], []),
      }),
  };
  const account = (p) => ({ owner: p, subaccount: [] });
  const { Init, factory } = ledgerTypes(IDL);
  const ledger = await f.pic.setupCanister({
    sender: owner,
    idlFactory: factory,
    targetCanisterId: Principal.fromText("73mez-iiaaa-aaaaq-aaasq-cai"),
    wasm: resolve(root, "target/tools/ic-icrc1-ledger.wasm.gz"),
    cycles: 100_000_000_000_000n,
    arg: IDL.encode(
      [Init],
      [
        {
          Init: {
            minting_account: account(other),
            fee_collector_account: [],
            transfer_fee: 10n,
            decimals: [8],
            max_memo_length: [32],
            token_symbol: "TEST",
            token_name: "Official local ledger",
            metadata: [],
            initial_balances: [[account(owner), 100_000_000_000n]],
            feature_flags: [{ icrc2: true }],
            archive_options: {
              num_blocks_to_archive: 110n,
              trigger_threshold: 120n,
              max_transactions_per_response: [100n],
              max_message_size_bytes: [],
              cycles_for_archive_creation: [10_000_000_000_000n],
              node_max_memory_size_bytes: [],
              controller_id: owner,
              more_controller_ids: [],
            },
            index_principal: [],
          },
        },
      ],
    ),
  });
  ledger.actor.setPrincipal(owner);
  const drop = f.pic.createActor(
    () => IDL.Service({ fixture_drop_reply: IDL.Func([], [], []) }),
    f.canisterId,
  );
  drop.setPrincipal(owner);
  const credits = 2_000_000_000_000n;
  ok(
    await f.actor.set_funding_config([
      {
        ledger: ledger.canisterId,
        recipient: f.canisterId,
        cycles_per_kinic: credits,
      },
    ]),
  );
  const approve = async (amount) =>
    ok(
      await ledger.actor.icrc2_approve({
        from_subaccount: [],
        spender: account(f.canisterId),
        amount,
        expected_allowance: [],
        expires_at: [],
        fee: [10n],
        memo: [],
        created_at_time: [],
      }),
    );
  const quotes = new Map();
  const quote = async () => {
    const op = operation();
    const quoted = ok(
      await f.actor.quote_purchase({
        operation: op,
        beneficiary: owner,
        amount_e8s: 100_000_000n,
        min_credits: credits,
        created_at_time: BigInt(await f.pic.getTime()) * 1_000_000n,
      }),
    );
    quotes.set(Buffer.from(op).toString("hex"), quoted);
    return op;
  };
  const filler = async (count) => {
    for (let i = 0; i < count; i++)
      ok(
        await ledger.actor.icrc1_transfer({
          from_subaccount: [],
          to: account(
            Principal.selfAuthenticating(new Uint8Array(32).fill(92)),
          ),
          amount: 1n,
          fee: [10n],
          memo: [],
          created_at_time: [],
        }),
      );
  };
  await approve(10_000_000_000n);
  const first = await quote();
  await assert.rejects(
    (async () => {
      ok(await f.actor.pay_purchase(first));
      throw Error("LostResponse");
    })(),
    /LostResponse/,
  );
  assert.deepEqual(await f.actor.pay_purchase(first), {
    Err: { Conflict: null },
  });
  assert.ok("Paid" in ok(await f.actor.list_payments())[0].status);
  assert.equal(ok(await f.actor.account_balance()), credits);
  assert.equal(
    await ledger.actor.icrc1_balance_of(account(f.canisterId)),
    100_000_000n,
  );
  console.log(
    "PASS actual official ledger ICRC2 transfer and lost ingress reply/retry credit once",
  );
  const archived = await quote();
  await drop.fixture_drop_reply();
  assert.ok("Unknown" in ok(await f.actor.pay_purchase(archived)).status);
  assert.equal(ok(await f.actor.account_balance()), credits);
  assert.equal(
    await ledger.actor.icrc1_balance_of(account(f.canisterId)),
    200_000_000n,
  );
  await filler(130);
  await f.pic.tick(20);
  const history = await ledger.actor.icrc3_get_blocks([
    { start: 0n, length: 100n },
  ]);
  assert.ok(
    history.archived_blocks.length > 0,
    "official ledger must create an actual archive",
  );
  const archiveId = history.archived_blocks[0].callback[0];
  const archiveStatus = await pic.canisterStatus({
    canisterId: archiveId,
    sender: owner,
  });
  assert.equal(
    Buffer.from(archiveStatus.moduleHash).toString("hex"),
    createHash("sha256")
      .update(
        readFileSync(resolve(root, "target/tools/ic-icrc1-archive.wasm.gz")),
      )
      .digest("hex"),
    "embedded archive must match pinned official archive Wasm",
  );
  const before = ok(await f.actor.account_balance());
  const raced = await Promise.all([
    f.actor.reconcile_purchase(archived),
    f.actor.reconcile_purchase(archived),
  ]);
  for (const result of raced)
    if ("Err" in result) assert.deepEqual(result, { Err: { Busy: null } });
  const found = ok(
    raced.find(
      (result) => "Ok" in result && "Paid" in result.Ok.payment.status,
    ),
  );
  assert.ok("Paid" in found.payment.status);
  assert.ok(found.scanned <= 100n);
  assert.equal(ok(await f.actor.account_balance()), before + credits);
  await f.actor.reconcile_purchase(archived);
  await f.actor.pay_purchase(archived);
  assert.equal(ok(await f.actor.account_balance()), before + credits);
  console.log(
    "PASS actual archive callback identifies post-await lost transfer and credits exactly once",
  );
  // Zero allowance makes the next actual transfer fail; the fault fixture discards
  // that rejection, giving genuine absence of matching evidence after Unknown.
  await approve(0n);
  const absent = await quote();
  await drop.fixture_drop_reply();
  assert.ok("Unknown" in ok(await f.actor.pay_purchase(absent)).status);
  const absentRecord = quotes.get(Buffer.from(absent).toString("hex"));
  // Same owner, recipient, amount, explicit fee, memo and timestamp, but no
  // delegated spender: an actual direct transfer is not purchase evidence.
  ok(
    await ledger.actor.icrc1_transfer({
      from_subaccount: [],
      to: account(f.canisterId),
      amount: 100_000_000n,
      fee: [10n],
      memo: [absentRecord.memo],
      created_at_time: [absentRecord.created_at_time],
    }),
  );
  await filler(220);
  await f.pic.tick(20);
  const balance = ok(await f.actor.account_balance());
  let progress = ok(await f.actor.reconcile_purchase(absent));
  assert.ok(progress.scanned > 0n && progress.scanned <= 100n);
  assert.equal(progress.can_continue, true);
  const next = progress.next;
  await f.upgrade();
  progress = ok(await f.actor.reconcile_purchase(absent));
  assert.ok(progress.next > next);
  assert.ok(progress.scanned <= 100n);
  let calls = 0;
  while (progress.can_continue && calls++ < 10) {
    progress = ok(await f.actor.reconcile_purchase(absent));
    assert.ok(progress.scanned <= 100n);
  }
  assert.equal(progress.can_continue, false);
  assert.ok("Unknown" in progress.payment.status);
  assert.equal(ok(await f.actor.account_balance()), balance);
  assert.equal(
    await ledger.actor.icrc1_balance_of(account(f.canisterId)),
    300_000_000n,
  );
  console.log(
    "PASS wrong actual transaction tuples never credit;100-block continuation and cursor survive upgrade",
  );
} finally {
  try {
    await pic?.tearDown();
  } finally {
    await server.stop();
  }
}
