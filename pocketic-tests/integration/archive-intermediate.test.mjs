// Controller-only retention in the original SQLite image; synthetic data only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import test from 'node:test';
import {idlFactory as baseFactory} from '../../packages/vfs-candid/index.ts';
const req=createRequire(realpathSync(createRequire(import.meta.url).resolve('@dfinity/pic')));
const {IDL}=req('@icp-sdk/core/candid');
const {Principal}=req('@icp-sdk/core/principal');
const {PocketIc,PocketIcServer}=req('@dfinity/pic');
if(process.env.POCKET_IC_BIN)PocketIcServer.getBinPath=()=>process.env.POCKET_IC_BIN;
const idlFactory=({IDL})=>{
 const Node=IDL.Record({path:IDL.Text,kind:IDL.Variant({File:IDL.Null,Folder:IDL.Null,Source:IDL.Null}),content:IDL.Text,metadata_json:IDL.Text,etag:IDL.Text,created_at:IDL.Int64,updated_at:IDL.Int64});
 const opt=IDL.Opt(IDL.Text), Result=t=>IDL.Variant({Ok:t,Err:IDL.Text});
 const Snapshot=IDL.Record({database_id:IDL.Text,prefix:opt,limit:IDL.Nat32,cursor:opt,snapshot_revision:opt,snapshot_session_id:opt});
 const SnapshotResult=IDL.Record({snapshot_revision:IDL.Text,snapshot_session_id:opt,nodes:IDL.Vec(Node),next_cursor:opt});
 const Updates=IDL.Record({database_id:IDL.Text,prefix:opt,limit:IDL.Nat32,cursor:opt,known_snapshot_revision:IDL.Text,target_snapshot_revision:opt});
 const UpdatesResult=IDL.Record({snapshot_revision:IDL.Text,changed_nodes:IDL.Vec(Node),removed_paths:IDL.Vec(IDL.Text),next_cursor:opt});
 return IDL.Service({...Object.fromEntries(baseFactory({IDL})._fields),export_snapshot:IDL.Func([Snapshot],[Result(SnapshotResult)],['query']),fetch_updates:IDL.Func([Updates],[Result(UpdatesResult)],['query'])});
};
const owner=Principal.selfAuthenticating(new Uint8Array(32).fill(71));
const writer=Principal.selfAuthenticating(new Uint8Array(32).fill(72));
const sha=s=>createHash('sha256').update(s).digest('hex');
const ok=r=>{assert.ok('Ok' in r,JSON.stringify(r,(_,v)=>typeof v==='bigint'?v.toString():v));return r.Ok;};
const configType=IDL.Record({kinic_ledger_canister_id:IDL.Text,billing_authority_id:IDL.Text,iap_authority_id:IDL.Opt(IDL.Text),cycles_per_kinic:IDL.Nat64,min_update_cycles:IDL.Nat64,top_up:IDL.Record({enabled:IDL.Bool,threshold_cycles:IDL.Nat,launcher_principal:IDL.Text})});
const config={kinic_ledger_canister_id:'aaaaa-aa',billing_authority_id:owner.toText(),iap_authority_id:[owner.toText()],cycles_per_kinic:1000n,min_update_cycles:1000000n,top_up:{enabled:false,threshold_cycles:1000000000n,launcher_principal:'aaaaa-aa'}};
const snapshot=async(a,database_id)=>ok(await a.export_snapshot({database_id,prefix:['/'],limit:1,cursor:[],snapshot_revision:[],snapshot_session_id:[]})).snapshot_revision;
const file=(path,content,kind='File',metadata={})=>({path,content,kind:{[kind]:null},metadata_json:JSON.stringify(metadata),expected_etag:[]});

test('upgrade_and_archive_reuse_same_mount_without_stable_memory_growth',{timeout:300000},async()=>{
 const server=await PocketIcServer.start();const pic=await PocketIc.create(server.getUrl());
 try{
  const wasm=process.env.KINIC_ARCHIVE_WASM||resolve('target/wasm32-unknown-unknown/release/vfs_canister.wasm');
  const baseline=process.env.KINIC_ARCHIVE_BASELINE_WASM;assert.ok(baseline);
  const {actor,canisterId}=await pic.setupCanister({sender:owner,controllers:[owner],idlFactory,wasm:baseline,arg:IDL.encode([configType],[config]),cycles:30000000000000n});actor.setPrincipal(owner);
  const database_id=ok(await actor.create_database({name:'Synthetic retention fixture'})).database_id;
  ok(await actor.grant_database_cycles_from_iap({database_id,provider:'apple_iap',external_payment_id:'retention-fixture',product_id:'test.cycles',purchaser_principal:owner.toText(),amount_cycles:2000000000000n}));
  ok(await actor.grant_database_access(database_id,writer.toText(),{Writer:null}));
  const directory=`/Sources/learning-runs/${sha('run')}`;
  for(const path of ['/Sources/learning-runs',directory])ok(await actor.mkdir_node({database_id,path}));
  const make=(id)=>{const path=`${directory}/${sha(id)}.json`;const content=JSON.stringify({id,run_id:'run',kind:'hook',payload:{capture:{event:'PostToolUse',terminal:false,text:'syntheticRetentionNeedle '.repeat(13000)}}});return file(path,content,'Source');};
  const one=make('first');ok(await actor.write_nodes({database_id,nodes:[one,file('/Knowledge/keep.md','preserve other data','File',{protected:true})]}));
  const r=ok(await actor.current_node_revision({database_id,path:one.path}))[0];
  const original=ok(await actor.read_node(database_id,'/Knowledge/keep.md'));
  await pic.upgradeCanister({sender:owner,canisterId,wasm,arg:IDL.encode([],[])});
  const stats=ok(await actor.database_storage_stats({database_id}));
  const beforeSnapshot=await snapshot(actor,database_id);
  const request={database_id,expected_mount:stats.mount_id,path:one.path,expected_etag:r.node.etag,expected_node_id:r.node_id,expected_revision:r.revision,expected_content_hash:r.content_hash,expected_snapshot_revision:beforeSnapshot,backup_manifest_sha256:sha('verified synthetic backup')};
  actor.setPrincipal(writer);
  assert.match((await actor.archive_intermediate_source(request)).Err,/controller/);
  assert.match((await actor.database_storage_stats({database_id})).Err,/controller/);
  actor.setPrincipal(owner);
  assert.ok('Err' in await actor.archive_intermediate_source({...request,expected_mount:stats.mount_id+1}));
  assert.ok('Err' in await actor.archive_intermediate_source({...request,expected_revision:r.revision+1n}));
  assert.deepEqual(ok(await actor.current_node_revision({database_id,path:one.path}))[0],r);
  const stableBefore=(await pic.getStableMemory(canisterId)).byteLength;
  const result=ok(await actor.archive_intermediate_source(request));
  assert.ok(result.after.freelist_pages>result.before.freelist_pages+50n);
  assert.equal(result.after.page_count,result.before.page_count);
  const committed=ok(await actor.database_storage_stats({database_id}));
  assert.equal(committed.mount_id,stats.mount_id);
  assert.deepEqual(committed.pages,result.after);
  assert.deepEqual(ok(await actor.read_node(database_id,one.path)),[]);
  assert.deepEqual(ok(await actor.node_history({database_id,node_id:r.node_id,limit:100,before_revision:[]})).revisions,[]);
  const delta=ok(await actor.fetch_updates({database_id,prefix:['/'],known_snapshot_revision:beforeSnapshot,target_snapshot_revision:[],cursor:[],limit:100}));
  assert.ok(delta.removed_paths.includes(one.path));
  // A duplicated/uncertain request must fail closed and never touch another node.
  assert.ok('Err' in await actor.archive_intermediate_source(request));
  ok(await actor.write_nodes({database_id,nodes:[file('/Knowledge/reuse.md','r'.repeat(100000))]}));
  const reused=ok(await actor.database_storage_stats({database_id}));
  assert.ok(reused.pages.freelist_pages<result.after.freelist_pages);
  assert.equal(reused.pages.page_count,result.after.page_count);
  assert.equal((await pic.getStableMemory(canisterId)).byteLength,stableBefore);
  await pic.upgradeCanister({sender:owner,canisterId,wasm,arg:IDL.encode([],[])});
  assert.deepEqual(ok(await actor.read_node(database_id,'/Knowledge/keep.md')),original);
  assert.deepEqual(ok(await actor.node_history({database_id,node_id:r.node_id,limit:100,before_revision:[]})).revisions,[]);
  // No schema migration: the unchanged old software can read the retained state.
  await pic.upgradeCanister({sender:owner,canisterId,wasm:baseline,arg:IDL.encode([],[])});
  assert.deepEqual(ok(await actor.read_node(database_id,'/Knowledge/keep.md')),original);
  assert.deepEqual(ok(await actor.read_node(database_id,one.path)),[]);
  assert.deepEqual(ok(await actor.node_history({database_id,node_id:r.node_id,limit:100,before_revision:[]})).revisions,[]);
  console.log(JSON.stringify({same_mount:stats.mount_id,before:result.before,after:result.after,reused:reused.pages,stable_bytes:stableBefore},(_,v)=>typeof v==='bigint'?v.toString():v));
 }finally{await pic.tearDown();await server.stop();}
});
