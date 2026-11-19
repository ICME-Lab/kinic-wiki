// Actual current Wasm, real vetKD and document crypto. Synthetic ledger is installed
// by the owned PocketIC fixture but no purchase is made in this test.
import assert from "node:assert/strict";
import {resolve} from "node:path";
import {fixture,ok,err,owner,Principal,VaultClient} from "../helpers/vault-current.mjs";
const wasm=process.env.VAULT_GRANT_WASM ?? resolve("target/vault-synthetic-funding-build/wasm32-unknown-unknown/release/vault_canister.wasm");
const f=await fixture({wasm,fund:false});
const clients=[];
try {
  assert.equal(ok(await f.actor.account_balance()),0n);
  const configuredKey=ok(await f.actor.get_config())[0].key_name;
  assert.deepEqual(ok(await f.actor.vault_key_cost([])),ok(await f.actor.vault_key_cost([configuredKey])));
  assert.ok(ok(await f.actor.vault_key_cost(["test_key_1"])).fee>0n);
  const first=ok(await f.actor.initialize_vault_account());
  assert.equal(first.grant_cycles,10_000_000_000n);
  assert.equal(first.balance,10_000_000_000n);
  assert.equal(ok(await f.actor.initialize_vault_account()).balance,first.balance);
  const included=ok(await f.actor.vault_key_cost([]));
  assert.equal(included.first_key_free,true);
  assert.equal(included.owner_fee,0n);
  assert.ok(included.fee>10_000_000_000n,"the actual fee exceeds the free operating credit");
  err(await f.actorFor(Principal.anonymous()).initialize_vault_account(),"Unauthorized");
  const keys=new Map();let epoch=0,derives=0;
  const deviceKeys={epoch:async()=>epoch,get:async(binding)=>keys.get(binding),remove:async(binding)=>{keys.delete(binding);},put:async(binding,key,expected)=>{if(expected!==epoch)return false;keys.set(binding,key);return true;},forget:async()=>{epoch++;keys.clear();},subscribe:()=>()=>{}};
  const actor=new Proxy(f.actor,{get(target,key){if(key==="derive_vault_key")return async(...args)=>{derives++;const result=await target.derive_vault_key(...args);if(derives===1)throw Error("LostResponse");return result;};return target[key];}});
  const create=()=>{const c=new VaultClient({actor,identity:{getPrincipal:()=>owner},canister:f.canisterId.toText(),local:true,deviceKeys});clients.push(c);return c;};
  const client=create(),header=await client.create();
  await assert.rejects(client.open(header),/LostResponse/);
  assert.equal(ok(await f.actor.vault_key_cost([])).first_key_free,false);
  await client.open(header);
  assert.equal(client.deviceKeyStatus,"saved");
  const revision=await client.save({kind:"note",title:"Free account test"},new TextEncoder().encode("saved without funding"));
  client.destroy();
  const reopened=create();
  await reopened.open(header);
  assert.equal(derives,2,"reopened client must reuse verified root without paid derivation");
  assert.equal(new TextDecoder().decode((await reopened.read(revision)).plaintext),"saved without funding");
  const before=ok(await f.actor.account_balance());
  assert.ok(before>9_000_000_000n && before<10_000_000_000n,"only normal execution/storage fees debit the 10B credit");
  await reopened.forgetDeviceKeys();
  await assert.rejects(reopened.open(header),/QuotaExceeded/);
  assert.equal(ok(await f.actor.vault_key_cost([])).first_key_free,false);
  reopened.destroy();
  await f.upgrade();
  const after=ok(await f.actor.initialize_vault_account());
  assert.equal(after.grant_cycles,10_000_000_000n);
  assert.equal(ok(await f.actor.vault_key_cost([])).first_key_free,false);
  assert.ok(after.balance<=before,"upgrade/bootstrap must not replenish credit");
  console.log("PASS: new account 10B plus first-key subsidy, anonymous denial, sponsored real vetKD with exact lost-response replay and cached reuse, normal credit preserved; clearing keys or upgrading cannot renew the subsidy.");
}finally{for(const c of clients)c.destroy();await f.close();}


const fullFaucet = await fixture({
  wasm: resolve("target/vault-ii-acceptance/vault-state.wasm"),
  fund: false,
});
let fundedClient;
try {
  const paidBalance = 100_000_000_000n;
  await fullFaucet.controls.fixture_execute(
    "WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n<1024) " +
    "INSERT INTO key_subsidies(owner) SELECT 'fixture-subsidy-'||n FROM slots;" +
    `INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES('${owner.toText()}',${paidBalance},0);`,
  );
  assert.deepEqual(ok(await fullFaucet.actor.initialize_vault_account()), {balance:paidBalance,grant_cycles:0n});
  const keyCost = ok(await fullFaucet.actor.vault_key_cost([]));
  assert.equal(keyCost.first_key_free, false);
  assert.equal(keyCost.owner_fee, keyCost.fee);
  fundedClient = new VaultClient({
    actor: fullFaucet.actor,
    identity: { getPrincipal: () => owner },
    canister: fullFaucet.canisterId.toText(),
    local: true,
  });
  const header = await fundedClient.create();
  await fundedClient.open(header);
  assert.ok(ok(await fullFaucet.actor.account_balance()) < paidBalance - keyCost.fee);
  console.log("PASS: paid account initialization, creation and real key retrieval remain available after the subsidy faucet fills.");
} finally {
  fundedClient?.destroy();
  await fullFaucet.close();
}
