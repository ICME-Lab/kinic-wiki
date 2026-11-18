// Actual Chromium IndexedDB/CryptoKey persistence + real VaultClient cache hits.
// Synthetic actors only; no claim of real II/vetKD acceptance.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url)).replace(/\/$/,"");
const url=process.env.VAULT_FIXTURE_URL ?? "http://127.0.0.1:3137";
const browser=await chromium.launch({headless:true});
const context=await browser.newContext();
try {
  const page=await context.newPage();
  await page.goto(`${url}/?state=welcome`);
  async function exercise(page, seed) {
    return page.evaluate(async ({root,seed})=>{
      const {BrowserDeviceKeys}=await import(`/@fs${root}/packages/vault-client/src/device-keys.ts`);
      const {VaultClient}=await import(`/@fs${root}/packages/vault-client/src/api.ts`);
      const {anchoredMaster,importKey,utf8}=await import(`/@fs${root}/packages/vault-crypto/src/index.ts`);
      const {contextInput}=await import(`/@fs${root}/packages/vault-crypto/src/context.ts`);
      const Principal=window.syntheticVault.identity.getPrincipal().constructor;
      const owner=Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
      const scope=`${owner.toText()}:${owner.toText()}`;
      const store=new BrowserDeviceKeys(scope);
      const pub=anchoredMaster("test_key_1",true).deriveCanisterKey(owner.toUint8Array()).deriveSubKey(utf8.encode("kinic-vault/ii-only/v1")).publicKeyBytes();
      const h={id:new Uint8Array(16).fill(1),nonce:new Uint8Array(32).fill(2),public_key:pub,key_name:"test_key_1",sequence:0n,state:{Active:null}};
      const c={canister:owner.toText(),owner:owner.toText(),vault:h.id,nonce:h.nonce,key_name:h.key_name};
      const binding=JSON.stringify([Array.from(contextInput(c)),Array.from(pub),"root/v3"]);
      if(seed) await store.put(binding,await importKey(new Uint8Array(32).fill(8)),await store.epoch());
      let derivations=0;
      const actor={get_vault_header:async()=>({Ok:h}),derive_vault_key:async()=>{derivations++;throw Error("unexpected paid derivation");}};
      const client=new VaultClient({actor,identity:{getPrincipal:()=>owner},canister:owner.toText(),local:true});
      await client.open(h);
      const key=client.session.root;
      const nonce=new Uint8Array(12);
      const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce},key,new TextEncoder().encode("persistent test"));
      const plain=new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:nonce},key,cipher));
      window.deviceTest={client,store,binding};
      return {saved:client.deviceKeyStatus,extractable:key.extractable,derivations,plain};
    },{root,seed});
  }
  assert.deepEqual(await exercise(page,true),{saved:"saved",extractable:false,derivations:0,plain:"persistent test"});
  await page.reload();
  assert.equal((await exercise(page,false)).derivations,0);
  const second=await context.newPage();
  await second.goto(`${url}/?state=welcome`);
  assert.equal((await exercise(second,false)).saved,"saved");
  await page.evaluate(async()=>{
    const {client,store,binding}=window.deviceTest;
    const epoch=await store.epoch();
    const key=client.session.root;
    await client.forgetDeviceKeys();
    if(await store.put(binding,key,epoch))throw Error("forgotten generation resurrected");
    if(await store.get(binding,await store.epoch()))throw Error("key still stored");
  });
  await second.waitForFunction(()=>!window.deviceTest.client.session.root);
  console.log("PASS: non-extractable key persistence, real client cache hit after reload, no derive call, stale-write rejection and cross-tab forget. Synthetic actor only.");
}finally{await browser.close();}
