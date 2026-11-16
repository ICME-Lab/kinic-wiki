// Local baseline characterization only; never production or live funds.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startVaultPocketIc } from '../helpers/vault-pocketic-server.mjs';
import { createVaultPocketIcWithTestKeys } from '../helpers/vault-pocketic-test-keys.mjs';
import { ledgerTypes } from '../helpers/official-icrc-ledger.mjs';
const root=resolve(import.meta.dirname,'../..');
const output=resolve(root,'target/vault-credit-baseline82');
const baseline='82f03ce7da704e07d895cd4f1ef9df2827964148';
const manifest=JSON.parse(readFileSync(resolve(output,'source.json'),'utf8'));
assert.equal(manifest.baseline,baseline);
const oldBinding=execFileSync('didc',['bind','--target','js',resolve(output,'vault.did')],{encoding:'utf8'});
const {idlFactory}=await import(`data:text/javascript;base64,${Buffer.from(oldBinding).toString('base64')}`);
const {VaultClient}=await import(pathToFileURL(resolve(output,'client/client.mjs')).href);
const dep=createRequire(resolve(root,'pocketic-tests/package.json'));
const req=createRequire(realpathSync(dep.resolve('@dfinity/pic')));
const { IDL }=req('@icp-sdk/core/candid');
const { Principal }=req('@icp-sdk/core/principal');
const binary=process.env.POCKET_IC_BIN;
assert.ok(binary,'POCKET_IC_BIN must identify verified PocketIC 16.1');
const version=execFileSync(binary,['--version'],{encoding:'utf8'}).trim();
assert.equal(version,'pocket-ic-server 16.1.0');
const ledgerPath=resolve(root,'target/tools/ic-icrc1-ledger.wasm.gz');
assert.equal(createHash('sha256').update(readFileSync(ledgerPath)).digest('hex'),'354dd6ecfdc72b5409805b31dea22c9db11df6e14095a5a68924eb63535e6d8a');
const owner=Principal.selfAuthenticating(new Uint8Array(32).fill(90));
const minter=Principal.selfAuthenticating(new Uint8Array(32).fill(91));
const account=p=>({owner:p,subaccount:[]});
const ok=r=>{assert.ok('Ok' in r,JSON.stringify(r,(_,v)=>typeof v==='bigint'?String(v):v));return r.Ok;};
const op=()=>globalThis.crypto.getRandomValues(new Uint8Array(16));
const server=await startVaultPocketIc(binary); let pic;
try {
 pic=await createVaultPocketIcWithTestKeys(server.getUrl(),{application:[{state:{type:'new'}}],fiduciary:{state:{type:'new'}},icpConfig:{betaFeatures:'Enabled'}});
 await pic.setTime(Date.now());
 const v=await pic.setupCanister({sender:owner,idlFactory,wasm:resolve(output,'vault_canister.wasm'),cycles:100_000_000_000_000n}); v.actor.setPrincipal(owner);
 ok(await v.actor.set_config([{key_name:'key_1',minimum_cycles:100_000_000_000n}]));
 const {Init,factory}=ledgerTypes(IDL);
 const l=await pic.setupCanister({sender:owner,idlFactory:factory,targetCanisterId:Principal.fromText('73mez-iiaaa-aaaaq-aaasq-cai'),wasm:ledgerPath,cycles:100_000_000_000_000n,arg:IDL.encode([Init],[{Init:{minting_account:account(minter),fee_collector_account:[],transfer_fee:10n,decimals:[8],max_memo_length:[32],token_symbol:'LOCAL',token_name:'Baseline local ledger',metadata:[],initial_balances:[[account(owner),100_000_000_000n]],feature_flags:[{icrc2:true}],archive_options:{num_blocks_to_archive:110n,trigger_threshold:120n,max_transactions_per_response:[100n],max_message_size_bytes:[],cycles_for_archive_creation:[10_000_000_000_000n],node_max_memory_size_bytes:[],controller_id:owner,more_controller_ids:[]},index_principal:[]}}])});
 l.actor.setPrincipal(owner);
 ok(await v.actor.set_funding_config([{ledger:l.canisterId,recipient:v.canisterId,cycles_per_kinic:2_000_000_000_000n}]));
 ok(await l.actor.icrc2_approve({from_subaccount:[],spender:account(v.canisterId),amount:100_000_000_000n,expected_allowance:[],expires_at:[],fee:[],memo:[],created_at_time:[]}));
 const operation=op(); ok(await v.actor.quote_purchase({operation,beneficiary:owner,amount_e8s:100_000_000n,min_credits:2_000_000_000_000n,created_at_time:BigInt(await pic.getTime())*1_000_000n}));
 assert.ok('Paid' in ok(await v.actor.pay_purchase(operation)).status);
 const calls=[], replays=[]; let dropAction, verifiedRevision;
 const actor=new Proxy(v.actor,{get(t,n){const f=t[n];return typeof f!=='function'?f:async(...args)=>{calls.push({name:n,action:args[0]?.action?Object.keys(args[0].action)[0]:undefined});const result=await f.apply(t,args); if(n==='mutate')replays.push({request:structuredClone(args[0]),result:structuredClone(result)}); if(n==='mutate' && dropAction && dropAction in args[0].action){dropAction=undefined;ok(result);throw Error('LostResponse');} return result;};}});
 const c=new VaultClient({actor,identity:{getPrincipal:()=>owner},canister:v.canisterId.toText(),local:true});
 const header=await c.create(); await c.open(header);
 const results=[];
 for(const size of [32,262144]) {
  calls.length=0; const bytes=new Uint8Array(size).fill(65); const start=performance.now();
  const rev=await c.save({kind:'note',title:'baseline measurement'},bytes); verifiedRevision=rev; const elapsed_ms=performance.now()-start;
  const saveCalls=structuredClone(calls); assert.deepEqual((await c.read(rev)).plaintext,bytes);
  results.push({plaintext_bytes:size,elapsed_ms,calls:saveCalls,update_count:saveCalls.filter(x=>x.name==='mutate').length});
 }
 const oldPayment=ok(await v.actor.payment_status(operation));
 const pendingPlaintext=new Uint8Array(1048577).fill(66); dropAction='PutChunk';
 await assert.rejects(c.save({kind:'attachment',title:'pending old upload'},pendingPlaintext),/LostResponse/);
 const pending=(await c.pendingUploads()).entries[0]; assert.ok(pending);
 const oldUpload=ok(await v.actor.get_upload_status(pending.upload));
 const replayCount=replays.length;
 const balance=ok(await v.actor.account_balance());
 await pic.upgradeCanister({sender:owner,canisterId:v.canisterId,wasm:resolve(root,'target/wasm32-unknown-unknown/release/vault_canister.wasm'),arg:IDL.encode([],[])});
 assert.equal(ok(await v.actor.account_balance()),balance);
 assert.deepEqual(ok(await v.actor.payment_status(operation)),oldPayment);
 assert.deepEqual(ok(await v.actor.get_upload_status(pending.upload)),oldUpload);
 for(const replay of replays) assert.deepEqual(await v.actor.mutate(replay.request),replay.result);
 const recovered=await c.resumeSave(); assert.deepEqual((await c.read(recovered)).plaintext,pendingPlaintext);
 const afterReplay=ok(await v.actor.account_balance()); assert.ok(afterReplay>0n && afterReplay<=balance); // Each replay still pays the existing execution meter (api::finish_at).
 let downgradeError;
 try { await pic.upgradeCanister({sender:owner,canisterId:v.canisterId,wasm:resolve(output,'vault_canister.wasm'),arg:IDL.encode([],[])}); }
 catch(error){downgradeError=String(error);}
 assert.ok(downgradeError,'Schema8 binary must reject schema9 store');
 assert.equal(ok(await v.actor.account_balance()),afterReplay);
 const last=results.at(-1); assert.equal(last.plaintext_bytes,262144);
 const committed=verifiedRevision;
 assert.ok(committed,'Expected committed revision result');
 assert.deepEqual((await c.read(committed)).plaintext,new Uint8Array(262144).fill(65));
 c.session.lock();
 const report={source_commit:baseline,target_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),environment:'local PocketIC; host elapsed time; production latency unmeasured',version,productionDeployment:false,realFunds:false,wasm_sha256:{frozen_vault:manifest.artifacts.vault_canister.sha256,current_vault:createHash('sha256').update(readFileSync(resolve(root,'target/wasm32-unknown-unknown/release/vault_canister.wasm'))).digest('hex')},frozen_client_executable_sha256:manifest.client.executableSha256,legacy_mutation_replays_before_pending_completion:replayCount,pending_upload_preserved_and_resumed:true,old_paid_payment_preserved:true,post_upgrade_replay_and_completion_execution_charged_cycles:String(balance-afterReplay),balance_preserved_across_upgrade:true,ciphertext_preserved:true,downgrade_rejected:true,downgrade_error:downgradeError,results};
 writeFileSync(resolve(output,'vault-upgrade.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(results));
} finally { try {await pic?.tearDown();} finally {await server.stop();} }
