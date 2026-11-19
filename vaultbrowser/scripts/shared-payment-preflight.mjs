import assert from "node:assert/strict";
import { Actor, CanisterStatus, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";

export function validateDeployment(setup, liveModuleHash, wiki, vault) {
  assert.equal(liveModuleHash, setup.wasmSha256, "Unexpected installed Vault module");
  assert.ok("Ok" in wiki && "Ok" in vault && vault.Ok.length === 1, "Both funding configurations must be present");
  const wikiLedger = wiki.Ok.kinic_ledger_canister_id;
  const vaultLedger = vault.Ok[0].ledger.toText();
  assert.equal(wikiLedger, setup.ids.ledger, "Unexpected Wiki billing ledger");
  assert.equal(vaultLedger, setup.ids.ledger, "Unexpected Vault funding ledger");
  return {liveModuleHash, wikiLedger, vaultLedger};
}

// Called after the verifier binds the manifest and URLs to its disposable local replica.
export async function readDeployment(setup) {
  const {ids, replica} = setup;
  const agent = HttpAgent.createSync({host:replica});
  await agent.fetchRootKey();
  const wiki = Actor.createActor(({IDL})=>IDL.Service({
    get_cycles_billing_config:IDL.Func([], [IDL.Variant({Ok:IDL.Record({kinic_ledger_canister_id:IDL.Text}), Err:IDL.Text})], ["query"]),
  }), {agent, canisterId:ids.wiki});
  const vault = Actor.createActor(({IDL})=>IDL.Service({
    get_funding_config:IDL.Func([], [IDL.Variant({Ok:IDL.Opt(IDL.Record({ledger:IDL.Principal})), Err:IDL.Reserved})], ["query"]),
  }), {agent, canisterId:ids.vault});
  const [status, wikiConfig, vaultConfig] = await Promise.all([
    CanisterStatus.request({agent, canisterId:Principal.fromText(ids.vault), paths:["module_hash"]}),
    wiki.get_cycles_billing_config(), vault.get_funding_config(),
  ]);
  return validateDeployment(setup, status.get("module_hash"), wikiConfig, vaultConfig);
}
