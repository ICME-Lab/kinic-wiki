import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { idlFactory } from "../../packages/vfs-candid/index.ts";
const req = createRequire(realpathSync(createRequire(import.meta.url).resolve("@dfinity/pic")));
const { IDL } = req("@icp-sdk/core/candid");
const { Principal } = req("@icp-sdk/core/principal");
const { PocketIc, PocketIcServer } = req("@dfinity/pic");
if (process.env.POCKET_IC_BIN) PocketIcServer.getBinPath = () => process.env.POCKET_IC_BIN;
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(7));
const reader = Principal.selfAuthenticating(new Uint8Array(32).fill(8));
const configType = IDL.Record({
  kinic_ledger_canister_id: IDL.Text, billing_authority_id: IDL.Text,
  iap_authority_id: IDL.Opt(IDL.Text), cycles_per_kinic: IDL.Nat64,
  min_update_cycles: IDL.Nat64,
  top_up: IDL.Record({ enabled: IDL.Bool, threshold_cycles: IDL.Nat, launcher_principal: IDL.Text }),
});
const config = {
  kinic_ledger_canister_id: "aaaaa-aa", billing_authority_id: owner.toText(),
  iap_authority_id: [owner.toText()], cycles_per_kinic: 1000n, min_update_cycles: 1000000n,
  top_up: { enabled: false, threshold_cycles: 1000000000n, launcher_principal: "aaaaa-aa" },
};
const ok = (result) => {
  assert.ok("Ok" in result, JSON.stringify(result, (_, value) => typeof value === "bigint" ? String(value) : value));
  return result.Ok;
};
test("retrieval search preserves legacy hits, Reader ACLs and bounded excerpts in real Wasm", async () => {
  const server = await PocketIcServer.start();
  const pic = await PocketIc.create(server.getUrl());
  try {
    const { actor, canisterId } = await pic.setupCanister({sender:owner,idlFactory,
      wasm:resolve(import.meta.dirname,"../../target/wasm32-unknown-unknown/release/vfs_canister.wasm"),
      arg:IDL.encode([configType],[config]),cycles:10000000000000n});
    actor.setPrincipal(owner);
    const id=ok(await actor.create_database({name:"Retrieval regression"})).database_id;
    ok(await actor.grant_database_cycles_from_iap({database_id:id,provider:"apple_iap",external_payment_id:"retrieval-regression",
      product_id:"test.cycles",purchaser_principal:owner.toText(),amount_cycles:1000000000000n}));
    for(const kind of ["normal","huge"])for(let i=0;i<20;i++){
      const content=kind==="normal"?"metadata\n## Content\nCORS origin credentials 日本語😀\0\ufeffend":
        "## Content\n"+"😀日本語 CORS origin credentials ".repeat(9000)+"outside-budget-marker";
      ok(await actor.write_node({database_id:id,path:`/${kind}-${i}.md`,kind:{File:null},content,metadata_json:"{}",expected_etag:[]}));
    }
    const request=query=>({database_id:id,query_text:query,intent:"CORS origin credentials",prefix:[],top_k:20});
    actor.setPrincipal(reader);assert.ok("Err" in await actor.search_nodes_for_retrieval(request("normal")));
    actor.setPrincipal(Principal.anonymous());assert.ok("Err" in await actor.search_nodes_for_retrieval(request("normal")));
    for(const caller of [reader,Principal.anonymous()]){
      actor.setPrincipal(owner);ok(await actor.grant_database_access(id,caller.toText(),{Reader:null}));actor.setPrincipal(caller);
      for(const query of ["normal","huge"]){
        const result=ok(await actor.search_nodes_for_retrieval(request(query)));
        const legacy=ok(await actor.search_nodes({...request(query),preview_mode:[{Light:null}]}));
        if(query==="normal")assert.ok(result.every(r=>r.rerank_excerpt.endsWith("\0\ufeffend")));
        assert.equal(result.length,20);assert.deepEqual(result.map(r=>r.hit),legacy);
        assert.ok(result.every(r=>r.rerank_excerpt.length<=512&&!r.rerank_excerpt.includes('outside-budget-marker')&&!r.rerank_excerpt.includes('�')));
      }
      assert.ok("Err" in await actor.search_nodes_for_retrieval({...request("normal"),top_k:21}));
      assert.ok("Err" in await actor.search_nodes_for_retrieval({...request("normal"),intent:"😀".repeat(257)}));
    }
    actor.setPrincipal(owner);
    ok(await actor.write_node({database_id:id,path:"/after-errors.md",kind:{File:null},content:"normal",metadata_json:"{}",expected_etag:[]}));
    assert.ok(ok(await actor.search_nodes_for_retrieval(request("after-errors"))).length);
    // Diagnostic Wasm has the identical implementation plus a query-only instruction counter.
    await pic.upgradeCanister({sender:owner,canisterId,wasm:resolve(import.meta.dirname,"../../target/retrieval-bench.wasm")});
    const requestType=IDL.Record({database_id:IDL.Text,query_text:IDL.Text,intent:IDL.Text,prefix:IDL.Opt(IDL.Text),top_k:IDL.Nat32});
    const outputType=IDL.Variant({Ok:IDL.Record({instructions:IDL.Nat64,response_bytes:IDL.Nat64,hits:IDL.Nat32}),Err:IDL.Text});
    const observations=[];
    for(const query of ["normal","huge"])for(const retrieval of [false,true]){
      const wire=await pic.queryCall({sender:owner,canisterId,method:"bench_retrieval_search",arg:IDL.encode([requestType,IDL.Bool],[request(query),retrieval])});
      const measure=ok(IDL.decode([outputType],wire)[0]);assert.ok(measure.instructions>0n);assert.ok(measure.response_bytes<262144n);assert.equal(measure.hits,20);
      observations.push({query,retrieval,...measure});
    }
    console.log("RETRIEVAL_WASM_METRICS "+JSON.stringify(observations,(_,v)=>typeof v==='bigint'?v.toString():v));
  } finally {await pic.tearDown();await server.stop();}
});
