import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createSignedReplica} from './signed-replica.mjs';
import {runCpuStudy,summarizeCpuSamples,summarizeProfile} from './cpu-study.mjs';
import {transformExperiment,runPairedExperiments} from './cpu-experiments.mjs';
const cpuStudy=process.argv.includes('--cpu-study')||process.argv.includes('--paired');
const delegatedFixture=process.argv.includes('--delegated');
const direct=process.argv.includes('--direct');
const uncached=process.argv.includes('--uncached');
const edgeProcess=process.argv.includes('--edge-process');
const readsOnly=process.argv.includes('--reads-only');
const readStages=process.argv.includes('--read-stages');
const multipleSessions=process.argv.includes('--multiple-sessions');
const readScenario=process.argv.find(a=>a.startsWith('--read-scenario='))?.slice(16)??'heavyread';
assert.ok(['heavyread','tenpages','multidb'].includes(readScenario));
let sampleStage;
const stageSamples=[];
const readParallel=Number(process.argv.find(a=>a.startsWith('--read-parallel='))?.slice(16)??4);
assert.ok([1,2,4,8].includes(readParallel),'Read parallelism must be 1, 2, 4 or 8');
assert.ok(!edgeProcess||!direct,'--edge-process requires the DO route');
const project=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const dir=fileURLToPath(new URL(process.env.WIKI_MCP_BENCH_OUTPUT_DIR??'./.tmp/',import.meta.url)).replace(/\/?$/,'/');
await mkdir(dir,{recursive:true});
const req=createRequire(project+'/workers/wiki-mcp/package.json');
const {build}=req('esbuild');
const {Miniflare,convertV4MiniflareOptions}=createRequire(req.resolve('wrangler'))('miniflare');
const {Cbor}=req('@icp-sdk/core/agent');const {IDL}=req('@icp-sdk/core/candid');const {Ed25519KeyIdentity,DelegationChain}=req('@icp-sdk/core/identity');
const idlBuilt=await build({entryPoints:[project+'/packages/vfs-candid/index.ts'],bundle:true,platform:'node',format:'esm',write:false});
await writeFile(dir+'idl-bench.mjs',idlBuilt.outputFiles[0].text);
const {idlFactory}=await import(pathToFileURL(dir+'idl-bench.mjs').href);
const fields=idlFactory({IDL}).fieldsAsObject();
const replica=await createSignedReplica('6emaw-iyaaa-aaaay-aacka-cai');
let signatureFault=null;
const metrics={queries:0,reads:0,jev:0,rewrite:0,active:0,maxActive:0,status:0,readState:0,signedQueries:0};
const server=createServer(async(request,response)=>{
 try{
 const chunks=[];for await(const p of request)chunks.push(p);const body=Buffer.concat(chunks);
 const pathname=new URL(request.url,'http://fixture').pathname;
 if(pathname==='/memory-stage'){const phase=JSON.parse(body).phase;assert.ok(['received','decoded','formatted'].includes(phase));await sampleStage?.(phase);response.writeHead(200).end();return;}
 if(pathname==='/jev'||pathname==='/rewrite'){
  const parsed=JSON.parse(body);const scenario=parsed.state?.search_intent??'';metrics[pathname.slice(1)]++;
  if(scenario.includes('timeout')){await new Promise(r=>setTimeout(r,2800));response.writeHead(503).end();return;}
  if(scenario.includes('provider-error')){response.writeHead(503).end('{}');return;}
  if(scenario.includes('provider-large')){response.writeHead(200,{'content-type':'application/json'}).end(' '.repeat(70000));return;}
  await new Promise(r=>setTimeout(r,pathname==='/jev'?190:650));
  response.writeHead(200,{'content-type':'application/json'});
  if(pathname==='/rewrite')response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({queries:['origin','credentials']})}}]}));
  else response.end(JSON.stringify({answers:Object.fromEntries(parsed.state.candidates.map((c,i)=>[c.id,{type:'noul',noul:(i+1)/parsed.state.candidates.length}]))}));return;
 }
 if(pathname.endsWith('/status')){metrics.status++;response.writeHead(200,{'content-type':'application/cbor'}).end(Buffer.from(Cbor.encode({root_key:replica.rootKey})));return;}
 if(pathname.endsWith('/read_state')){metrics.readState++;response.writeHead(200,{'content-type':'application/cbor'}).end(Buffer.from(await replica.readState(signatureFault==='certificate')));return;}
 const envelope=Cbor.decode(body);const method=envelope.content.method_name;const type=fields[method];const args=IDL.decode(type.argTypes,new Uint8Array(envelope.content.arg));
 const db=method.startsWith('search_nodes')?args[0].database_id:args[0];let result;
 metrics.active++;metrics.maxActive=Math.max(metrics.maxActive,metrics.active);
 await new Promise(r=>setTimeout(r,10));
 if(method.startsWith('search_nodes')){
  metrics.queries++;const q=args[0];const group=createHash('sha256').update(q.query_text).digest('hex').slice(0,6);
  const size=db.includes('oversize')?18000:db.includes('longpaths')?4000:100;
  result={Ok:Array.from({length:Number(q.top_k)},(_,i)=>({path:'/Knowledge/'+group+'/'+String(i)+'-'+'p'.repeat(size)+'.md',kind:{File:null},score:-i,match_reasons:['content_fts'],snippet:[],preview:[{field:{Content:null},char_offset:0,match_reason:'content_fts',excerpt:[('CORS origin credentials 😀 日本語 '.repeat(30)).slice(0,Object.keys(q.preview_mode?.[0]??{})[0]==='ContentStart'?512:96)]}]}))};
 if(method==='search_nodes_for_retrieval')result.Ok=result.Ok.map(hit=>({hit,rerank_excerpt:'CORS origin credentials 😀 日本語 '.repeat(30).slice(0,512)}));
 }else if(method==='read_nodes'){
  metrics.reads++;result={Ok:args[1].map(path=>({Ok:[{path,kind:{File:null},content:db.includes('multidb')?`\uFEFF${db}:${path}\n`+'😀日本語\u0000'.repeat(70000):'😀日本語\u0000'.repeat(db.includes('tenpages')?6000:6600).slice(0,40000),created_at:0n,updated_at:0n,etag:'v1',metadata_json:JSON.stringify({details:'metadata'.repeat(1000)})}]}))};
  // Match vfs_runtime::read_nodes: reserve framing and encode every item
  // before deciding whether it fits the one-million-byte response budget.
  let used=1024+args[1].length*128;
  result.Ok=result.Ok.map(item=>{
   const bytes=IDL.encode(fields.read_node.retTypes,[item]).byteLength;
   if(used+bytes>1_000_000)return {Err:'read_nodes item exceeds response byte limit'};
   used+=bytes;return item;
  });
 }else throw new Error('Unexpected method '+method);
 const arg=IDL.encode(type.retTypes,[result]);
 if(method==='read_nodes'&&db.includes('multidb')){assert.equal(args[1].length,1);assert.ok(arg.byteLength>980_000&&arg.byteLength<1_000_000,'Exercise one near-limit response per database');assert.ok(result.Ok.every(item=>'Ok' in item));}
 let encoded=await replica.query(envelope.content,arg,signatureFault==='query');metrics.signedQueries++;
 if(signatureFault==='body'){
  const altered=Cbor.decode(encoded);altered.reply.arg[altered.reply.arg.length-1]^=1;
  encoded=Cbor.encode(altered);
 }
 metrics.active--;response.writeHead(200,{'content-type':'application/cbor'}).end(Buffer.from(encoded));
 }catch(e){metrics.active=Math.max(0,metrics.active-1);response.writeHead(500).end(String(e.message));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const fixtureOrigin='http://127.0.0.1:'+server.address().port;
function instrumentReadFormatter(source) {
 if(!readStages)return source;
 for(const [args,call,format] of [
  ['database_id, paths','readPaths','toReadPathsToolResult'],
  ['ids','fetchManySearchResults','toFetchManyToolResult']
 ]) {
  const anchor=`async ({ ${args} }) => ${format}(await ${call}(env, { ${args} }))`;
  assert.ok(source.includes(anchor),'Read formatter probe anchor missing');
  source=source.replace(anchor,`async ({ ${args} }) => { const payload=await ${call}(env,{${args}});if(globalThis.__benchMemoryCheckpoint)await globalThis.__benchMemoryCheckpoint('decoded');const result=${format}(payload);if(globalThis.__benchMemoryCheckpoint)await globalThis.__benchMemoryCheckpoint('formatted');return result; }`);
 }
 return source;
}
const bundle=await build({stdin:{contents:`import worker from '${project}/workers/wiki-mcp/src/${direct?'index':'entry'}.ts';export {McpAuthStateV5} from '${project}/workers/wiki-mcp/src/auth/state.ts';export default {fetch(request,env,ctx){
 if(new URL(request.url).pathname==='/__fixture/memory'){return request.json().then(({enabled})=>{globalThis.__benchMemoryCheckpoint=enabled?phase=>fetch('${fixtureOrigin}/memory-stage',{method:'POST',body:JSON.stringify({phase})}):undefined;return new Response('ok');});}
 if(new URL(request.url).pathname==='/__fixture/clear-node-keys')return request.json().then(async({sessionId})=>{await env.MCP_AUTH_STATE.getByName('session:'+sessionId).clearBenchmarkNodeKeys();return new Response('ok');});
 ${delegatedFixture?`if(new URL(request.url).pathname==='/__fixture/delegation'){return request.json().then(async({sessionId,material})=>{await env.MCP_AUTH_STATE.getByName('session:'+sessionId).seedBenchmarkDelegation(material);return new Response('ok');});}`:''}
 return worker.fetch(request,env,ctx);}};`,resolveDir:project+'/workers/wiki-mcp',loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers','node:*'],plugins:[{name:'local-benchmark-only',setup(b){
 b.onLoad({filter:/(?:candid\/utils\/hash\.js|server\/zod-json-schema-compat\.js|ii-server\/internet-identity\.ts|wiki-mcp\/src\/bounded-response\.ts)$/},async({path})=>({contents:transformExperiment(path,await readFile(path,'utf8')),loader:path.endsWith('.ts')?'ts':'js',resolveDir:path.slice(0,path.lastIndexOf('/'))}));
 b.onLoad({filter:/wiki-mcp\/src\/index\.ts$/},async({path})=>({contents:instrumentReadFormatter(transformExperiment(path,await readFile(path,'utf8'))).replace('const url = new URL(request.url);', `${process.argv.includes('--paired')?"globalThis.__wikiCpuExperiment=new Set((new URL(request.url).searchParams.get('experiment')??'').split(','));":''}const mode=new URL(request.url).searchParams.get('variant');env={...env,MCP_SEARCH_RERANK_ENABLED:mode==='combined'?'true':'false'};const url = new URL(request.url);`),loader:'ts',resolveDir:project+'/workers/wiki-mcp/src'}));
 if(readStages)b.onLoad({filter:/agent\/agent\/http\/index\.js$/},async({path})=>{
  let source=await readFile(path,'utf8');
  const anchor='const queryResponse = cbor.decode(responseBytes);';
  assert.ok(source.includes(anchor));
  source=source.replace(anchor,`if(globalThis.__benchMemoryCheckpoint)await globalThis.__benchMemoryCheckpoint('received');const queryResponse=cbor.decode(responseBytes);`);
  return {contents:source,loader:'js',resolveDir:path.slice(0,path.lastIndexOf('/'))};
 });
 b.onLoad({filter:/ii-server\/verified-node-key-store\.ts$/},async({path})=>({contents:(await readFile(path,'utf8')).replace('store: NodeKeyStore = verifiedNodeKeys',uncached?'store: NodeKeyStore = new VerifiedNodeKeyStore()':'store: NodeKeyStore = verifiedNodeKeys')+`\nexport function clearBenchmarkNodeKeys(){verifiedNodeKeys.entries.clear();}`,loader:'ts',resolveDir:project+'/packages/ii-server'}));
 b.onLoad({filter:/wiki-mcp\/src\/auth\/state\.ts$/},async({path})=>({
  contents:(await readFile(path,'utf8')).replace('  async invalidate(): Promise<void> {', `
  async clearBenchmarkNodeKeys(){const {clearBenchmarkNodeKeys}=await import('@kinic/ii-server/verified-node-key-store');clearBenchmarkNodeKeys();}
  ${delegatedFixture?`async seedBenchmarkDelegation(material: KinicDelegationMaterialV1) {
    const record=await this.ctx.storage.get<AuthorizationSessionRecordV5>(RECORD_KEY);
    if(!record||record.phase!=="active")throw new Error("Missing local fixture session");
    record.identitySource="internet_identity";record.reviewAccessVersion=null;
    record.cachedDelegation=await encryptJson(material,requiredEncryptionKey(this.env),delegationContext(record.sessionId,material.targetOrigin));
    record.cachedDelegationTargetOrigin=material.targetOrigin;record.cachedDelegationExpiresAt=material.expiresAt;
    await this.ctx.storage.put(RECORD_KEY,record);
  }`:''}
  async invalidate(): Promise<void> {`),loader:'ts',resolveDir:project+'/workers/wiki-mcp/src/auth'
 }));
 b.onLoad({filter:/packages\/jev-reranker\/index\.ts$/},async({path})=>({contents:(await readFile(path,'utf8')).replace('https://api.typesafe.ai/v1/systemone',fixtureOrigin+'/jev'),loader:'ts',resolveDir:project+'/packages/jev-reranker'}));
 }}]});
const identity=Ed25519KeyIdentity.generate();const hash=s=>createHash('sha256').update(s).digest('base64url');const origin='https://wiki-private-mcp.kinic.xyz';
const mf=new Miniflare(convertV4MiniflareOptions({name:'search-resource-study',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-12',compatibilityFlags:['nodejs_compat'],inspectorPort:0,ratelimits:{MCP_REGISTRATION_RATE_LIMIT:{namespace_id:'7802027',simple:{limit:1000,period:60}},MCP_REVIEW_LOGIN_RATE_LIMIT:{namespace_id:'7802029',simple:{limit:1000,period:60}}},durableObjects:{MCP_AUTH_STATE:{className:'McpAuthStateV5',useSQLite:true}},bindings:{TYPESAFE_API_KEY:'local-fixture',KINIC_WIKI_CANISTER_ID:'6emaw-iyaaa-aaaay-aacka-cai',KINIC_WIKI_IC_HOST:fixtureOrigin,KINIC_WIKI_MCP_TARGET_ORIGIN:'https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app',KINIC_WIKI_PUBLIC_ORIGIN:'https://wiki.kinic.xyz',MCP_PUBLIC_ORIGIN:origin,MCP_ACCESS_POLICY:'private_required',MCP_WRITE_POLICY:'private',MCP_KEY_ENCRYPTION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',MCP_REVIEW_LOGIN_ENABLED:'true',MCP_REVIEW_USERNAME_HASH:hash('bench'),MCP_REVIEW_PASSWORD_HASH:hash('bench-password'),MCP_REVIEW_IDENTITY_KEY:JSON.stringify(identity.toJSON()),MCP_REVIEW_IDENTITY_PRINCIPAL:identity.getPrincipal().toText(),MCP_REVIEW_ACCESS_VERSION:'bench-v1',MCP_REVIEW_DATABASE_ID:'db_abcdefghijkl',MCP_REVIEW_WRITE_PREFIX:'/scratch',BENCH_PROVIDER_URL:fixtureOrigin}}));
let socket,edge;let measuredBundle=bundle.outputFiles[0].text;const results=[];
const manifest={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 node:process.version,arguments:process.argv.slice(2),bundleSha256:createHash('sha256').update(measuredBundle).digest('hex')};
try{
 const call=(path,options)=>(edge&&!path.startsWith('/__fixture/')?edge:mf).dispatchFetch(origin+path,options);
 const reg=await call('/oauth/register',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'198.51.100.5'},body:JSON.stringify({redirect_uris:['https://chatgpt.com/connector/oauth/callback'],grant_types:['authorization_code'],token_endpoint_auth_method:'none'})});assert.equal(reg.status,201);const client=await reg.json();const verifier='r'.repeat(43);
 async function createSession(){
 const auth=await call('/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'https://chatgpt.com/connector/oauth/callback',state:'bench-state',resource:origin+'/mcp',scope:'mcp:read',code_challenge:hash(verifier),code_challenge_method:'S256'}),{redirect:'manual'});
 const html=await auth.text();const cookie=auth.headers.get('set-cookie').split(';')[0];const connectState=html.match(/name="connect_state" value="([A-Za-z0-9_-]+)"/)[1];
 const login=await call('/oauth/connect/reviewer',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',cookie,'cf-connecting-ip':'198.51.100.5'},body:new URLSearchParams({connect_state:connectState,username:'bench',password:'bench-password'}).toString()});assert.equal(login.status,302);
 const code=new URL(login.headers.get('location')).searchParams.get('code');const tokenResponse=await call('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:'https://chatgpt.com/connector/oauth/callback',code_verifier:verifier,resource:origin+'/mcp'}).toString()});assert.equal(tokenResponse.status,200);return (await tokenResponse.json()).access_token;
 }
 const token=await createSession();
 const tokens=[token];
 if(multipleSessions)for(let i=1;i<8;i++)tokens.push(await createSession());
 if(delegatedFixture)for(const sessionToken of tokens){
  const appKey=Ed25519KeyIdentity.generate();const rootKey=Ed25519KeyIdentity.generate();
  const expiresAt=Date.now()+5*60_000;
  const chain=await DelegationChain.create(rootKey,appKey.getPublicKey(),new Date(expiresAt));
  const seeded=await call('/__fixture/delegation',{method:'POST',body:JSON.stringify({sessionId:sessionToken.split('.')[1],material:{version:1,targetOrigin:'https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app',expiresAt,appKey:appKey.toJSON(),delegation:chain.toJSON()}})});
  assert.equal(seeded.status,200);
 }
 // A separate local process lets OS counters isolate forwarding from SDK/DO
 // execution. The proxy adds local HTTP overhead; this is NOT billed Worker CPU
 // or a replica of Cloudflare's placement/startup scheduling.
 const backendPid=execFileSync('pgrep',['-P',String(process.pid),'-x','workerd'],{encoding:'utf8'}).trim();
 if(edgeProcess){
  const edgeBundle=await build({stdin:{contents:`import worker from '${project}/workers/wiki-mcp/src/entry.ts';export {McpAuthStateV5} from '${project}/workers/wiki-mcp/src/auth/state.ts';export default{fetch(request,env){return worker.fetch(request,{...env,MCP_AUTH_STATE:{getByName:()=>env.BENCH_BACKEND}});}}`,resolveDir:project+'/workers/wiki-mcp',loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers','node:*']});
  measuredBundle=edgeBundle.outputFiles[0].text;manifest.bundleSha256=createHash('sha256').update(measuredBundle).digest('hex');
  edge=new Miniflare(convertV4MiniflareOptions({name:'edge-forwarding-study',modules:true,script:edgeBundle.outputFiles[0].text,compatibilityDate:'2026-05-12',compatibilityFlags:['nodejs_compat'],inspectorPort:0,bindings:{MCP_ACCESS_POLICY:'private_required'},serviceBindings:{BENCH_BACKEND:request=>mf.dispatchFetch(request.url,{method:request.method,headers:request.headers,body:request.body,duplex:'half'})}}));
  await edge.ready;
 }
 const inspector=await (edge??mf).getInspectorURL();inspector.protocol='http:';inspector.pathname='/json';const targets=await(await fetch(inspector)).json();socket=new WebSocket(targets.find(t=>t.id.includes(edgeProcess?'edge-forwarding-study':'search-resource-study'))?.webSocketDebuggerUrl??targets[0].webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let next=0;const pending=new Map();socket.addEventListener('message',e=>{const reply=JSON.parse(String(e.data));const p=pending.get(reply.id);if(p){pending.delete(reply.id);reply.error?p.reject(new Error(reply.error.message)):p.resolve(reply.result);}});const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 sampleStage=async phase=>{const heap=await send('Runtime.getHeapUsage');stageSamples.push({phase,heap:heap.usedSize,backing:heap.backingStorageSize??0,combined:heap.usedSize+(heap.backingStorageSize??0)});};
 const pids=execFileSync('pgrep',['-P',String(process.pid),'-x','workerd'],{encoding:'utf8'}).trim().split('\n');const pid=edgeProcess?pids.find(p=>p!==backendPid):backendPid;assert.match(pid,/^\d+$/);
 const cpu=()=>Number(execFileSync('python3',['-c',`import ctypes,struct,sys\nl=ctypes.CDLL('/usr/lib/libproc.dylib');s=ctypes.CDLL('/usr/lib/libSystem.B.dylib');b=ctypes.create_string_buffer(1024);assert l.proc_pid_rusage(int(sys.argv[1]),0,ctypes.byref(b))==0;t=(ctypes.c_uint32*2)();assert s.mach_timebase_info(ctypes.byref(t))==0;print(sum(struct.unpack_from('QQ',b.raw,16))*int(t[0])/int(t[1])/1e6)`,pid],{encoding:'utf8'}).trim());
 let sequence=0;
 async function request(variant,scenario,read=false,options={}) {
  const limit=options.limit??10, multiDb=read&&scenario==='multidb';
  const paths=Array.from({length:10},(_,i)=>'/Knowledge/'+i+'.md');
  const ids=paths.map((path,i)=>`https://wiki.kinic.xyz/db/db_multidb_${i}${path}`);
  const params=read?(multiDb?{name:'fetch_many',arguments:{ids}}:
   {name:'read_paths',arguments:{database_id:'db_'+scenario,paths}}):
   {name:'search',arguments:{database_id:'db_'+scenario,query:'Hono CORS origin methods '+scenario,limit}};
  const requestToken=tokens[sequence%tokens.length];
  const start=performance.now();
  const r=await call('/mcp?variant='+variant+'&experiment='+encodeURIComponent(options.experiment??''),{
   method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+requestToken,'mcp-protocol-version':'2025-11-25'},
   body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method:options.toolsList?'tools/list':'tools/call',params})
  });
  const text=await r.text();assert.equal(r.status,200,text.slice(0,200));
  let json;try{json=JSON.parse(text);}catch{json=JSON.parse(text.split('\n').find(l=>l.startsWith('data: ')).slice(6));}
  assert.ok(!json.error,JSON.stringify(json.error));assert.ok(Buffer.byteLength(JSON.stringify(json.result))<=256000);
  if(options.toolsList)assert.ok(json.result.tools.length>0);
  else if(read||(!signatureFault&&!['oversize','longpaths'].includes(scenario))){
   assert.ok(!json.result.isError,JSON.stringify(json.result).slice(0,300));
   assert.equal(json.result.structuredContent?.results?.length,read?10:limit);
  }else assert.equal(json.result.isError,true);
  const items=json.result.structuredContent?.results;
  const itemErrors=items?.filter(item=>item.is_error===true).length??0;
  if(read)assert.equal(itemErrors,signatureFault?10:scenario==='heavyread'?1:0,'Match canister per-item byte budget');
  if(multiDb&&!signatureFault)for(const [i,item] of items.entries()){
   assert.equal(item.id,ids[i]);assert.equal(item.metadata.database_id,`db_multidb_${i}`);
   assert.equal(item.metadata.path,paths[i]);assert.equal(item.metadata.etag,'v1');
   assert.equal(item.metadata.truncated,true);
   assert.equal(item.metadata.metadata_json,JSON.stringify({details:'metadata'.repeat(1000)}));
   assert.ok(item.text.startsWith(`\uFEFFdb_multidb_${i}:${paths[i]}\n😀日本語\u0000`));
   assert.ok(item.text.isWellFormed());assert.ok(json.result.content[0].text.includes(item.text));
  }
  return {wallMs:performance.now()-start,bytes:Buffer.byteLength(text),error:json.result.isError===true,count:items?.length,itemErrors};
 }
 let firstSearchCpuMs;
 if(cpuStudy){const before=cpu();await request('combined','normal');firstSearchCpuMs=cpu()-before;}
 const integrity=[];
 for(const fault of ['query','certificate']){await call('/__fixture/clear-node-keys',{method:'POST',body:JSON.stringify({sessionId:token.split('.')[1]})});signatureFault=fault;const modelCalls=metrics.jev;const cpuStart=cpu();const result=await request('combined','normal');const cpuMs=cpu()-cpuStart;assert.equal(result.error,true);assert.equal(metrics.jev,modelCalls,'Untrusted hits must not reach Jev');integrity.push({fault,rejected:true,cpuMs});}
 signatureFault=null;await request('combined','normal');
 const beforeRotation={...metrics};replica.rotateNodeKeys();const rotationStart=cpu();await request('combined','normal');const rotationCpuMs=cpu()-rotationStart;
 assert.equal(metrics.readState-beforeRotation.readState,1,'Rotated node keys must be certificate-verified');
 assert.equal(metrics.queries-beforeRotation.queries,3,'Key refresh must not replay the query');
 integrity.push({fault:'node-key-rotation',reverified:true,cpuMs:rotationCpuMs});
 await request('baseline','normal');
 if(!cpuStudy&&(!readsOnly||readScenario==='multidb')){
  for(const fault of ['query','body']){
   signatureFault=fault;
   const response=await request('baseline','multidb',true);
   assert.equal(response.itemErrors,10);
   integrity.push({fault:'large-'+fault,rejected:true});
  }
  signatureFault=null;
  const beforeKeys={...metrics};replica.rotateNodeKeys();
  await request('baseline','multidb',true);
  assert.equal(metrics.readState-beforeKeys.readState,1);
  assert.equal(metrics.reads-beforeKeys.reads,10,'Refreshing keys must not replay body queries');
  integrity.push({fault:'large-node-key-rotation',reverified:true});
 }
 if(process.argv.includes('--paired'))await runPairedExperiments({request,cpu,metrics,dir,bundle:measuredBundle});
 else if(cpuStudy)await runCpuStudy({request,send,cpu,metrics,dir,bundle:measuredBundle,integrity,delegatedFixture,firstSearchCpuMs,direct,uncached,edgeProcess,
  setSignatureFault(value){signatureFault=value;}});
 const scenarios=cpuStudy?[]:readsOnly?[{variant:'baseline',scenario:readScenario,parallel:readParallel,repeats:12,read:true}]:[{variant:'baseline',scenario:'normal',parallel:1,repeats:8},{variant:'combined',scenario:'normal',parallel:1,repeats:8},{variant:'combined',scenario:'normal',parallel:8,repeats:12},...['longpaths','oversize','provider-error','provider-large','timeout'].map(scenario=>({variant:'combined',scenario,parallel:1,repeats:2})),{variant:'baseline',scenario:'heavyread',parallel:4,repeats:10,read:true},{variant:'baseline',scenario:'multidb',parallel:8,repeats:12,read:true}];
 for(const cfg of scenarios){
  metrics.maxActive=0;
  const before={...metrics};let largestHeap=0,largestBacking=0,largestCombined=0;const runs=[],individualCpuMs=[];
  const cpuStart=cpu();
  for(let i=0;i<cfg.repeats;i++) {
    if(cfg.parallel===1) {
      const start=cpu();runs.push(await request(cfg.variant,cfg.scenario,cfg.read));individualCpuMs.push(cpu()-start);
    } else runs.push(...await Promise.all(Array.from({length:cfg.parallel},()=>request(cfg.variant,cfg.scenario,cfg.read))));
  }
  const cpuMs=cpu()-cpuStart;
  // Heap sampling in a separate run avoids charging CDP polling to CPU measurements.
  if(readStages)await call('/__fixture/memory',{method:'POST',body:JSON.stringify({enabled:true})});
  const sampled=Array.from({length:cfg.parallel},()=>request(cfg.variant,cfg.scenario,cfg.read));let done=false;const finished=Promise.all(sampled).finally(()=>done=true);
  while(!done){const heap=await send('Runtime.getHeapUsage');largestHeap=Math.max(largestHeap,heap.usedSize);largestBacking=Math.max(largestBacking,heap.backingStorageSize??0);largestCombined=Math.max(largestCombined,heap.usedSize+(heap.backingStorageSize??0));await new Promise(r=>setTimeout(r,5));}await finished;
  if(readStages){await call('/__fixture/memory',{method:'POST',body:JSON.stringify({enabled:false})});if(cfg.read)for(const phase of ['received','decoded','formatted'])assert.equal(stageSamples.filter(s=>s.phase===phase).length,cfg.parallel*(phase==='received'&&cfg.scenario==='multidb'?10:1));}
  for(const sample of stageSamples){largestHeap=Math.max(largestHeap,sample.heap);largestBacking=Math.max(largestBacking,sample.backing);largestCombined=Math.max(largestCombined,sample.combined);}
  const retainedAfter=await send('Runtime.getHeapUsage');
  largestHeap=Math.max(largestHeap,retainedAfter.usedSize);
  largestBacking=Math.max(largestBacking,retainedAfter.backingStorageSize??0);
  largestCombined=Math.max(largestCombined,retainedAfter.usedSize+(retainedAfter.backingStorageSize??0));
  const individualCpu=cfg.parallel===1?summarizeCpuSamples(individualCpuMs):null;
  const gateApplies=cfg.variant==='combined'||cfg.read||edgeProcess;
  const passesGate=gateApplies?(largestCombined<=96*1024*1024&&cpuMs/runs.length<=(edgeProcess?10:50)&&(!edgeProcess||individualCpu===null||individualCpu.max<=10)):null;
  const result={...cfg,passesGate,retainedAfter,cpuMs,cpuMsPerRequest:cpuMs/runs.length,individualCpu,
    perRequestBudget:cfg.parallel===1?'measured_serially':'not_measured_under_concurrency',
    largestHeap,largestBacking,largestCombined,stageSamples:stageSamples.splice(0),runs,queries:metrics.queries-before.queries,reads:metrics.reads-before.reads,readState:metrics.readState-before.readState,rootKeyFetches:metrics.status-before.status,signedQueries:metrics.signedQueries-before.signedQueries,jevCalls:metrics.jev-before.jev,rewriteCalls:metrics.rewrite-before.rewrite,maxConcurrentCanisterRequests:metrics.maxActive};
  const requests=(cfg.repeats+1)*cfg.parallel;
  // Fail if a future adapter silently bypasses certificate retrieval or signing.
  assert.equal(result.readState,uncached?requests:0);
  assert.equal(result.rootKeyFetches,requests);
  assert.equal(result.signedQueries,result.queries+result.reads);
  if(cfg.read){
    assert.equal(result.reads,requests*(cfg.scenario==='multidb'?10:1));
    assert.equal(result.queries,0);assert.equal(result.jevCalls,0);
    assert.ok(result.maxConcurrentCanisterRequests<=cfg.parallel,'Consume one DB reply at a time per MCP request');
  }else{
    assert.equal(result.reads,0);
    assert.equal(result.queries,requests*(cfg.variant==='combined'&&cfg.scenario!=='oversize'?3:1));
    assert.ok(result.maxConcurrentCanisterRequests<=cfg.parallel*2);
  }
  if(cfg.read&&process.argv.includes('--read-profile')){
    await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:100});await send('Profiler.start');
    for(let n=0;n<4;n++)await request(cfg.variant,cfg.scenario,true);
    const {profile}=await send('Profiler.stop');
    await writeFile(dir+cfg.scenario+'.cpuprofile',JSON.stringify(profile));
    result.profile=summarizeProfile(profile,measuredBundle);
  }
  results.push(result);console.log(JSON.stringify({...result,runs:undefined}));
  await writeFile(dir+'resource-results.json',JSON.stringify({completed:false,results,metrics},null,2)+'\n',{mode:0o600});
 }
 if(!cpuStudy)await writeFile(dir+'resource-results.json',JSON.stringify({completed:true,manifest,direct,uncached,edgeProcess,readsOnly,readStages,multipleSessions,signatureVerification:true,integrity,passed:results.every(r=>r.passesGate!==false),results,metrics,note:'Actual private MCP HTTP, review OAuth, SQLite Durable Object, Ed25519 signing, Candid/CBOR and response formatter. Real SDK BLS verification of root/subnet certificates and Ed25519 query signatures enabled; local root key fetched via status. Corrupt query signatures and certificates are rejected before measurement; rotated node keys trigger certificate reverification without replaying queries. Search candidates simulate producer-side improved previews. The product retrieval pipeline and shared Jev implementation run unchanged except for the local Jev endpoint. Provider replies and network waits are fixture-controlled; live provider quality/latency measured separately. CPU is owned workerd process kernel CPU (including DO unless edgeProcess=true), not Cloudflare billed isolate CPU. edgeProcess uses a separate local HTTP bridge to isolate forwarding and is not the production topology. Heap is sampled main-isolate V8 use, not a strict true peak or full isolate-memory measurement.'},null,2)+'\n',{mode:0o600});
 assert.ok(results.every(r=>r.passesGate!==false),'Signed workload exceeds local CPU/memory gates; see resource-results.json');
}finally{socket?.close();await edge?.dispose();await mf.dispose();await new Promise(r=>server.close(r));}
