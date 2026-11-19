// Production Wasm on a disposable network. No wallet or user credits are involved.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { idlFactory as wikiIdl } from "../../packages/vfs-candid/index.ts";
import { idlFactory as vaultIdl } from "../../packages/vault-candid/index.js";
import { startVaultPocketIc } from "../helpers/vault-pocketic-server.mjs";

const req = createRequire(realpathSync(createRequire(import.meta.url).resolve("@dfinity/pic")));
const { IDL } = req("@icp-sdk/core/candid");
const { Principal } = req("@icp-sdk/core/principal");
const { PocketIc, PocketIcServer } = req("@dfinity/pic");
const wasmDir = process.env.VAULT_REFILL_WASM_DIR ?? resolve(import.meta.dirname, "../../target/vault-ii-acceptance");
const wasm = name => resolve(wasmDir, name);
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(8));
const topUp = IDL.Record({ enabled: IDL.Bool, threshold_cycles: IDL.Nat, launcher_principal: IDL.Text });
const billingType = IDL.Record({
  kinic_ledger_canister_id: IDL.Text, billing_authority_id: IDL.Text, iap_authority_id: IDL.Opt(IDL.Text),
  cycles_per_kinic: IDL.Nat64, min_update_cycles: IDL.Nat64, top_up: topUp,
});
const billing = {
  kinic_ledger_canister_id: "aaaaa-aa", billing_authority_id: owner.toText(), iap_authority_id: [],
  cycles_per_kinic: 1000n, min_update_cycles: 1_000_000n,
  top_up: { enabled: false, threshold_cycles: 1_000_000_000n, launcher_principal: "aaaaa-aa" },
};

function ok(value) {
  assert.ok("Ok" in value, value.Err);
  return value.Ok;
}

test("Wiki timer transfers real cycles across subnets after Vault authorizes the Wiki", { timeout: 120000 }, async () => {
  const server = await startVaultPocketIc(process.env.POCKET_IC_BIN ?? PocketIcServer.getBinPath());
  let pic;
  try {
    pic = await PocketIc.create(server.getUrl(), {
      application: [{ state: { type: "new" } }, { state: { type: "new" } }],
    });
    const [wikiSubnet, vaultSubnet] = await pic.getApplicationSubnets();
    const { actor: wiki, canisterId: wikiId } = await pic.setupCanister({
      idlFactory: wikiIdl, wasm: wasm("vfs_canister.wasm"), cycles: 10_000_000_000_000n,
      sender: owner, controllers: [owner], targetSubnetId: wikiSubnet.id,
      arg: IDL.encode([billingType], [billing]),
    });
    const { actor: vault, canisterId: vaultId } = await pic.setupCanister({
      idlFactory: vaultIdl, wasm: wasm("vault_canister.wasm"), cycles: 2_000_000_000_000n,
      sender: owner, controllers: [owner], targetSubnetId: vaultSubnet.id,
    });
    wiki.setPrincipal(owner);
    vault.setPrincipal(owner);
    await pic.tick(10);
    assert.deepEqual(ok(await wiki.get_vault_refill_state()), []);
    const refill = {
      target: vaultId, enabled: true, threshold_cycles: 3_000_000_000_000n,
      target_cycles: 4_000_000_000_000n, max_transfer_cycles: 300_000_000_000n,
    };
    wiki.setPrincipal(Principal.anonymous());
    assert.ok("Err" in await wiki.configure_vault_refill(refill));
    wiki.setPrincipal(owner);
    ok(await wiki.configure_vault_refill(refill));
    const initial = BigInt(await pic.getCyclesBalance(vaultId));
    const check = async () => ok(await wiki.check_vault_refill())[0].state;
    assert.ok("Failed" in (await check()).history.at(-1).outcome);
    assert.ok(BigInt(await pic.getCyclesBalance(vaultId)) <= initial);

    vault.setPrincipal(Principal.anonymous());
    assert.ok("Err" in await vault.set_cycles_refill_source([wikiId]));
    vault.setPrincipal(owner);
    ok(await vault.set_cycles_refill_source([wikiId]));
    assert.ok("Err" in await vault.cycles_balance_for_wiki());

    const before = BigInt(await pic.getCyclesBalance(vaultId));
    await pic.advanceTime(86_400_001);
    await pic.tick(50);
    const [{ target, state }] = ok(await wiki.get_vault_refill_state());
    assert.equal(target.toText(), vaultId.toText());
    assert.ok("Succeeded" in state.history.at(-1).outcome);
    assert.equal(state.history.at(-1).target[0].toText(), vaultId.toText());
    assert.equal(state.history.at(-1).amount_cycles, 300_000_000_000n);
    assert.ok(BigInt(await pic.getCyclesBalance(vaultId)) > before + 290_000_000_000n);
  } finally {
    try { await pic?.tearDown(); } finally { await server.stop(); }
  }
});
