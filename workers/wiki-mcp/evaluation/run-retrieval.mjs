// Run production Worker selection/Jev with Rust-produced excerpts and frozen public search hits.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../../../',import.meta.url));
const here=fileURLToPath(new URL('.',import.meta.url));
const req=createRequire(new URL('../package.json',import.meta.url));const {build}=req('esbuild');
const live=process.argv.includes('--live');
if(live)process.loadEnvFile(project+'.env.local');
const fixtureBytes=await readFile(here+'retrieval-fixture.json');const fixture=JSON.parse(fixtureBytes);
const pairs=[],keys=new Map();
for(const row of fixture.cases)for(const list of row.lists)for(const c of list.candidates){const key=row.id+':'+c.path;if(!keys.has(key)){keys.set(key,pairs.length);pairs.push([row.query,fixture.documents[row.databaseId+':'+c.path].content]);}}
// Boundary cases are also checked by Rust unit tests. This process executes the product function.
execFileSync('cargo',['build','-p','vfs-store','--example','retrieval_excerpts'],{cwd:project,stdio:['ignore','ignore','inherit']});
const excerpts=JSON.parse(execFileSync(project+'target/debug/examples/retrieval_excerpts',[],{input:JSON.stringify(pairs),maxBuffer:64*1024*1024}));
await mkdir(here+'.tmp',{recursive:true});
await build({entryPoints:[project+'workers/wiki-mcp/src/index.ts'],bundle:true,platform:'node',format:'esm',outfile:here+'.tmp/worker.mjs',
 alias:{'cloudflare:workers':project+'workers/wiki-mcp/tests/cloudflare-workers.ts'},
 banner:{js:"import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);"},
 plugins:[{name:'frozen-canister-search',setup(b){b.onLoad({filter:/wiki-mcp\/src\/vfs\.ts$/},async({path})=>({loader:'ts',resolveDir:project+'workers/wiki-mcp/src',contents:(await readFile(path,'utf8')).replace('export async function createRetrievalSearcher(env: RuntimeEnv)','async function unusedRetrievalSearcher(env: RuntimeEnv)')+'\nexport async function createRetrievalSearcher(){return globalThis.__retrievalFixtureSearch;}\n'}));}}]});
const {searchDatabase}=await import('./.tmp/worker.mjs');const realFetch=globalThis.fetch;
const replayPath=here+'recorded-jev.json';let recorded={};try{recorded=JSON.parse(await readFile(replayPath,'utf8'));}catch{}
const observations=[];
for(const row of fixture.cases){
 let calls=0,modelCalls=0,actualCandidates;
 globalThis.__retrievalFixtureSearch=async(db,query,intent,prefix)=>{
  assert.equal(db,row.databaseId);assert.equal(intent,row.query);assert.equal(prefix,'/');calls++;
  const list=row.lists.find(l=>l.query===query);assert.ok(list,`unexpected auxiliary query ${row.id}: ${query}`);
  return list.candidates.map(c=>({hit:{path:c.path,kind:c.metadata.kind,score:c.metadata.score,snippet:c.metadata.snippet,
    preview:{excerpt:c.preview,matchReason:c.metadata.match_reasons[0]??''},matchReasons:c.metadata.match_reasons},rerankExcerpt:excerpts[keys.get(row.id+':'+c.path)]}));
 };
 globalThis.fetch=async(url,options)=>{
  assert.equal(String(url),'https://api.typesafe.ai/v1/systemone');modelCalls++;
  const body=JSON.parse(options.body);actualCandidates=body.state.candidates.map(({path,preview})=>({path,preview}));
  if(row.referenceCandidates)assert.deepEqual(actualCandidates,row.referenceCandidates,`Rust/pipeline parity: ${row.id}`);
  const inputHash=createHash('sha256').update(JSON.stringify(actualCandidates)).digest('hex');
  let json;
  if(live){const response=await realFetch(url,options);if(!response.ok)return response;json=await response.json();recorded[row.id]={inputHash,body:json};}
  else if(recorded[row.id]){assert.equal(recorded[row.id].inputHash,inputHash);json=recorded[row.id].body;}
  else {assert.ok(row.referenceProbabilities,`record --live results before replaying ${row.id}`);json={answers:Object.fromEntries(row.referenceProbabilities.map((noul,i)=>['candidate_'+i,{type:'noul',noul}]))};}
  return new Response(JSON.stringify(json),{headers:{'content-type':'application/json'}});
 };
 const result=await searchDatabase({KINIC_WIKI_CANISTER_ID:'6emaw-iyaaa-aaaay-aacka-cai',MCP_SEARCH_RERANK_ENABLED:'true',TYPESAFE_API_KEY:live?process.env.TYPESAFE_API_KEY:'replay'},
  {database_id:row.databaseId,query:row.query,limit:10});
 assert.ok(result.results);assert.ok(calls<=3);assert.equal(modelCalls,1);
 if(row.referenceCandidates)assert.deepEqual(actualCandidates,row.referenceCandidates,`Rust/pipeline parity: ${row.id}`);
 const paths=result.results.map(r=>r.metadata.path);const rel=paths.map(p=>row.labels[p]===true);
 observations.push({id:row.id,split:row.split,absent:row.absent,paths,rel,queryCount:calls,modelCalls});
}
globalThis.fetch=realFetch;
const measured=observations.filter(r=>r.split==='holdout'&&!r.absent),confirmation=observations.filter(r=>r.split==='confirmation');
const metrics={questions:measured.length,hit10:measured.filter(r=>r.rel.some(Boolean)).length,p3:measured.reduce((n,r)=>n+r.rel.slice(0,3).filter(Boolean).length,0)/(measured.length*3),confirmation:confirmation.filter(r=>r.rel.some(Boolean)).length};
const report={live,fixtureSha256:createHash('sha256').update(fixtureBytes).digest('hex'),metrics,observations};
await writeFile(here+'.tmp/'+(live?'live':'replay')+'-results.json',JSON.stringify(report,null,2)+'\n');
if(live)await writeFile(replayPath,JSON.stringify(recorded)+'\n');
console.log(JSON.stringify(metrics));assert.ok(metrics.hit10>=19);assert.ok(metrics.p3>=.65);assert.ok(metrics.confirmation>=7);
