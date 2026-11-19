// Separate disposable instance, exact pinned official ledger and current working-tree Vault.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { idlFactory } from "../../packages/vault-candid/index.js";
import { installOfficialLedger } from "../helpers/official-icrc-ledger.mjs";
import { startVaultPocketIc } from "../helpers/vault-pocketic-server.mjs";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const sdk = createRequire(realpathSync(require.resolve("@dfinity/pic")));
const { IDL } = sdk("@icp-sdk/core/candid");
const { Principal } = sdk("@icp-sdk/core/principal");
const { PocketIc } = require("@dfinity/pic");
const account = (owner) => ({ owner, subaccount: [] });
const ok = (r) => {
  assert.ok("Ok" in r);
  return r.Ok;
};
const stable = ({
  wallet,
  request,
  config,
  fee,
  credits,
  memo,
  created_at_time,
}) => ({ wallet, request, config, fee, credits, memo, created_at_time });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("official ledger charges the wallet, credits an independent beneficiary once and enforces approval expiry", async () => {
  const binary = process.env.POCKET_IC_BIN;
  assert.equal(
    execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
    "pocket-ic-server 16.1.0",
  );
  const ledgerWasm = readFileSync(
    resolve(root, "target/tools/ic-icrc1-ledger.wasm.gz"),
  );
  assert.equal(
    sha(ledgerWasm),
    "354dd6ecfdc72b5409805b31dea22c9db11df6e14095a5a68924eb63535e6d8a",
  );
  const server = await startVaultPocketIc(binary);
  let pic;
  try {
    pic = await PocketIc.create(server.getUrl());
    await pic.setTime(Date.now());
    const payer = Principal.selfAuthenticating(randomBytes(32));
    const owner = Principal.selfAuthenticating(randomBytes(32));
    const wasm = resolve(process.env.VAULT_WALLET_ACCEPTANCE_WASM ??
      resolve(root, "target/vault-ii-acceptance/vault_canister.wasm"));
    console.log("Current Vault Wasm SHA-256", sha(readFileSync(wasm)));
    const vault = await pic.setupCanister({
      sender: owner,
      idlFactory,
      wasm,
      cycles: 100_000_000_000_000n,
    });
    const ledger = await installOfficialLedger({
      pic,
      IDL,
      Principal,
      root,
      owner: payer,
      other: owner,
    });
    vault.actor.setPrincipal(owner);
    const amount = 100_000_000n,
      fee = 10n,
      credits = 2_000_000_000_000n;
    ok(
      await vault.actor.set_funding_config([
        {
          ledger: ledger.canisterId,
          recipient: vault.canisterId,
          cycles_per_kinic: credits,
        },
      ]),
    );
    const beneficiary = pic.createActor(idlFactory, vault.canisterId);
    beneficiary.setPrincipal(owner);
    vault.actor.setPrincipal(payer);
    ledger.actor.setPrincipal(payer);
    const walletBalance = () => ledger.actor.icrc1_balance_of(account(payer));
    const allowance = () =>
      ledger.actor.icrc2_allowance({
        account: account(payer),
        spender: account(vault.canisterId),
      });
    const now = async () => BigInt(await pic.getTime()) * 1_000_000n;
    const approve = async (expires) =>
      ok(
        await ledger.actor.icrc2_approve({
          from_subaccount: [],
          spender: account(vault.canisterId),
          amount: amount + fee,
          expected_allowance: [0n],
          expires_at: [expires],
          fee: [fee],
          memo: [],
          created_at_time: [await now()],
        }),
      );
    const quote = async () =>
      ok(
        await vault.actor.quote_purchase({
          operation: randomBytes(16),
          beneficiary: owner,
          amount_e8s: amount,
          min_credits: credits,
          created_at_time: await now(),
        }),
      );
    const initial = await walletBalance(),
      initialCredit = ok(await beneficiary.account_balance());
    const quoted = await quote(),
      expiry = (await now()) + 60_000_000_000n;
    assert.equal(quoted.wallet.toText(), payer.toText());
    assert.equal(quoted.request.beneficiary.toText(), owner.toText());
    await approve(expiry);
    assert.deepEqual(await allowance(), {
      allowance: amount + fee,
      expires_at: [expiry],
    });
    const paid = ok(await vault.actor.pay_purchase(quoted.request.operation));
    assert.ok("Paid" in paid.status);
    assert.deepEqual(stable(paid), stable(quoted));
    assert.deepEqual(await vault.actor.pay_purchase(quoted.request.operation), {
      Err: { Conflict: null },
    });
    assert.deepEqual(
      stable(ok(await vault.actor.payment_status(quoted.request.operation))[0]),
      stable(quoted),
    );
    assert.equal(await walletBalance(), initial - amount - fee * 2n);
    assert.equal(
      await ledger.actor.icrc1_balance_of(account(vault.canisterId)),
      amount,
    );
    assert.equal(
      ok(await beneficiary.account_balance()),
      initialCredit + credits,
    );
    assert.equal(ok(await vault.actor.account_balance()), 0n);

    const second = await quote(),
      expiresSoon = (await now()) + 2_000_000_000n;
    await approve(expiresSoon);
    assert.equal((await allowance()).allowance, amount + fee);
    await pic.advanceTime(3_000);
    await pic.tick();
    assert.equal((await allowance()).allowance, 0n);
    const result = ok(await vault.actor.pay_purchase(second.request.operation));
    assert.deepEqual(result.status, { InsufficientAllowance: null });
    assert.deepEqual(stable(result), stable(second));
    assert.equal(await walletBalance(), initial - amount - fee * 3n);
    assert.equal(
      ok(await beneficiary.account_balance()),
      initialCredit + credits,
    );
    assert.equal(
      await ledger.actor.icrc1_balance_of(account(vault.canisterId)),
      amount,
    );
  } finally {
    try {
      await pic?.tearDown();
    } finally {
      await server.stop();
    }
  }
});
