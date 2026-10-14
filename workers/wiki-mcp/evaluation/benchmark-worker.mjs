import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createSignedReplica} from './signed-replica.mjs';
const project=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const dir=fileURLToPath(new URL('./.tmp/',import.meta.url));
await mkdir(dir,{recursive:true});
const req=createRequire(project+'/workers/wiki-mcp/package.json');
const {build}=req('esbuild');
const {Miniflare,convertV4MiniflareOptions}=createRequire(req.resolve('wrangler'))('miniflare');
const {Cbor}=req('@icp-sdk/core/agent');const {IDL}=req('@icp-sdk/core/candid');const {Ed25519KeyIdentity}=req('@icp-sdk/core/identity');
const idlBuilt=await build({entryPoints:[project+'/packages/vfs-candid/index.ts'],bundle:true,platform:'node',format:'esm',write:false});
await writeFile(dir+'idl-bench.mjs',idlBuilt.outputFiles[0].text);
const {idlFactory}=await import('./.tmp/idl-bench.mjs');
const fields=idlFactory({IDL}).fieldsAsObject();
const replica=await createSignedReplica('6emaw-iyaaa-aaaay-aacka-cai');
let signatureFault=null;
const metrics={queries:0,reads:0,jev:0,rewrite:0,active:0,maxActive:0,status:0,readState:0,signedQueries:0};
const server=createServer(async(request,response)=>{
 try{
 const chunks=[];for await(const p of request)chunks.push(p);const body=Buffer.concat(chunks);
 const pathname=new URL(request.url,'http://fixture').pathname;
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
  metrics.reads++;result={Ok:args[1].map(path=>({Ok:[{path,kind:{File:null},content:'😀日本語\u0000'.repeat(6600).slice(0,40000),created_at:0n,updated_at:0n,etag:'v1',metadata_json:JSON.stringify({details:'metadata'.repeat(1000)})}]}))};
 }else throw new Error('Unexpected method '+method);
 const arg=IDL.encode(type.retTypes,[result]);const encoded=await replica.query(envelope.content,arg,signatureFault==='query');metrics.signedQueries++;
 metrics.active--;response.writeHead(200,{'content-type':'application/cbor'}).end(Buffer.from(encoded));
 }catch(e){metrics.active=Math.max(0,metrics.active-1);response.writeHead(500).end(String(e.message));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const fixtureOrigin='http://127.0.0.1:'+server.address().port;
const bundle=await build({stdin:{contents:`import worker from '${project}/workers/wiki-mcp/src/index.ts';export {McpAuthStateV5} from '${project}/workers/wiki-mcp/src/index.ts';export default {fetch(request,env,ctx){const mode=new URL(request.url).searchParams.get('variant')??'baseline';return worker.fetch(request,{...env,MCP_SEARCH_RERANK_ENABLED:mode==='combined'?'true':'false'},ctx);}};`,resolveDir:project+'/workers/wiki-mcp',loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers','node:*'],plugins:[{name:'local-benchmark-only',setup(b){
 b.onLoad({filter:/packages\/jev-reranker\/index\.ts$/},async({path})=>({contents:(await readFile(path,'utf8')).replace('https://api.typesafe.ai/v1/systemone',fixtureOrigin+'/jev'),loader:'ts',resolveDir:project+'/packages/jev-reranker'}));
 }}]});
const identity=Ed25519KeyIdentity.generate();const hash=s=>createHash('sha256').update(s).digest('base64url');const origin='https://wiki-private-mcp.kinic.xyz';
const mf=new Miniflare(convertV4MiniflareOptions({name:'search-resource-study',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-12',compatibilityFlags:['nodejs_compat'],inspectorPort:0,ratelimits:{MCP_REGISTRATION_RATE_LIMIT:{namespace_id:'7802027',simple:{limit:1000,period:60}},MCP_REVIEW_LOGIN_RATE_LIMIT:{namespace_id:'7802029',simple:{limit:1000,period:60}}},durableObjects:{MCP_AUTH_STATE:{className:'McpAuthStateV5',useSQLite:true}},bindings:{TYPESAFE_API_KEY:'local-fixture',KINIC_WIKI_CANISTER_ID:'6emaw-iyaaa-aaaay-aacka-cai',KINIC_WIKI_IC_HOST:fixtureOrigin,KINIC_WIKI_MCP_TARGET_ORIGIN:'https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app',KINIC_WIKI_PUBLIC_ORIGIN:'https://wiki.kinic.xyz',MCP_PUBLIC_ORIGIN:origin,MCP_ACCESS_POLICY:'private_required',MCP_WRITE_POLICY:'disabled',MCP_KEY_ENCRYPTION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',MCP_REVIEW_LOGIN_ENABLED:'true',MCP_REVIEW_USERNAME_HASH:hash('bench'),MCP_REVIEW_PASSWORD_HASH:hash('bench-password'),MCP_REVIEW_IDENTITY_KEY:JSON.stringify(identity.toJSON()),MCP_REVIEW_IDENTITY_PRINCIPAL:identity.getPrincipal().toText(),MCP_REVIEW_ACCESS_VERSION:'bench-v1',MCP_REVIEW_DATABASE_ID:'db_abcdefghijkl',MCP_REVIEW_WRITE_PREFIX:'/scratch',BENCH_PROVIDER_URL:fixtureOrigin}}));
let socket;const results=[];
try{
 const call=(path,options)=>mf.dispatchFetch(origin+path,options);
 const reg=await call('/oauth/register',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'198.51.100.5'},body:JSON.stringify({redirect_uris:['https://chatgpt.com/connector/oauth/callback'],grant_types:['authorization_code'],token_endpoint_auth_method:'none'})});assert.equal(reg.status,201);const client=await reg.json();const verifier='r'.repeat(43);
 const auth=await call('/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'https://chatgpt.com/connector/oauth/callback',state:'bench-state',resource:origin+'/mcp',scope:'mcp:read',code_challenge:hash(verifier),code_challenge_method:'S256'}),{redirect:'manual'});
 const html=await auth.text();const cookie=auth.headers.get('set-cookie').split(';')[0];const connectState=html.match(/name="connect_state" value="([A-Za-z0-9_-]+)"/)[1];
 const login=await call('/oauth/connect/reviewer',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',cookie,'cf-connecting-ip':'198.51.100.5'},body:new URLSearchParams({connect_state:connectState,username:'bench',password:'bench-password'}).toString()});assert.equal(login.status,302);
 const code=new URL(login.headers.get('location')).searchParams.get('code');const tokenResponse=await call('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:'https://chatgpt.com/connector/oauth/callback',code_verifier:verifier,resource:origin+'/mcp'}).toString()});assert.equal(tokenResponse.status,200);const token=(await tokenResponse.json()).access_token;
 const inspector=await mf.getInspectorURL();inspector.protocol='http:';inspector.pathname='/json';const targets=await(await fetch(inspector)).json();socket=new WebSocket(targets.find(t=>t.id.includes('search-resource-study'))?.webSocketDebuggerUrl??targets[0].webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let next=0;const pending=new Map();socket.addEventListener('message',e=>{const reply=JSON.parse(String(e.data));const p=pending.get(reply.id);if(p){pending.delete(reply.id);reply.error?p.reject(new Error(reply.error.message)):p.resolve(reply.result);}});const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const pid=execFileSync('pgrep',['-P',String(process.pid),'-x','workerd'],{encoding:'utf8'}).trim();assert.match(pid,/^\d+$/);
 const cpu=()=>Number(execFileSync('python3',['-c',`import ctypes,struct,sys\nl=ctypes.CDLL('/usr/lib/libproc.dylib');s=ctypes.CDLL('/usr/lib/libSystem.B.dylib');b=ctypes.create_string_buffer(1024);assert l.proc_pid_rusage(int(sys.argv[1]),0,ctypes.byref(b))==0;t=(ctypes.c_uint32*2)();assert s.mach_timebase_info(ctypes.byref(t))==0;print(sum(struct.unpack_from('QQ',b.raw,16))*int(t[0])/int(t[1])/1e6)`,pid],{encoding:'utf8'}).trim());
 let sequence=0;
 async function request(variant,scenario,read=false){const start=performance.now();const r=await call('/mcp?variant='+variant,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token,'mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name:read?'read_paths':'search',arguments:read?{database_id:'db_'+scenario,paths:Array.from({length:10},(_,i)=>'/Knowledge/'+i+'.md')}:{database_id:'db_'+scenario,query:'Hono CORS origin methods '+scenario,limit:10}}})});const text=await r.text();assert.equal(r.status,200,text.slice(0,200));let json;try{json=JSON.parse(text);}catch{json=JSON.parse(text.split('\n').find(l=>l.startsWith('data: ')).slice(6));}assert.ok(!json.error,JSON.stringify(json.error));assert.ok(Buffer.byteLength(JSON.stringify(json.result))<=256000);if(!signatureFault&&!['oversize','longpaths'].includes(scenario)){assert.ok(!json.result.isError,JSON.stringify(json.result).slice(0,300));assert.equal(json.result.structuredContent?.results?.length,10);}else assert.equal(json.result.isError,true);return {wallMs:performance.now()-start,bytes:Buffer.byteLength(text),error:json.result.isError===true,count:json.result.structuredContent?.results?.length};}
 const integrity=[];
 for(const fault of ['query','certificate']){signatureFault=fault;const modelCalls=metrics.jev;const result=await request('combined','normal');assert.equal(result.error,true);assert.equal(metrics.jev,modelCalls,'Untrusted hits must not reach Jev');integrity.push({fault,rejected:true});}
 signatureFault=null;await request('combined','normal');
 await request('baseline','normal');
 const scenarios=[{variant:'baseline',scenario:'normal',parallel:1,repeats:8},{variant:'combined',scenario:'normal',parallel:1,repeats:8},{variant:'combined',scenario:'normal',parallel:8,repeats:12},...['longpaths','oversize','provider-error','provider-large','timeout'].map(scenario=>({variant:'combined',scenario,parallel:1,repeats:2})),{variant:'baseline',scenario:'heavyread',parallel:4,repeats:10,read:true}];
 for(const cfg of scenarios){
  metrics.maxActive=0;
  const before={...metrics};let largestHeap=0,largestBacking=0;const runs=[];
  const cpuStart=cpu();for(let i=0;i<cfg.repeats;i++)runs.push(...await Promise.all(Array.from({length:cfg.parallel},()=>request(cfg.variant,cfg.scenario,cfg.read))));const cpuMs=cpu()-cpuStart;
  // Heap sampling in a separate run avoids charging CDP polling to CPU measurements.
  const sampled=Array.from({length:cfg.parallel},()=>request(cfg.variant,cfg.scenario,cfg.read));let done=false;const finished=Promise.all(sampled).finally(()=>done=true);
  while(!done){const heap=await send('Runtime.getHeapUsage');largestHeap=Math.max(largestHeap,heap.usedSize);largestBacking=Math.max(largestBacking,heap.backingStorageSize??0);await new Promise(r=>setTimeout(r,5));}await finished;
  const retainedBefore=await send('Runtime.getHeapUsage');
  const passesGate=cfg.variant!=='combined'||((largestHeap+largestBacking)<=96*1024*1024&&cpuMs/runs.length<=50);
  const result={...cfg,passesGate,retainedBefore,cpuMs,cpuMsPerRequest:cpuMs/runs.length,largestHeap,largestBacking,runs,queries:metrics.queries-before.queries,reads:metrics.reads-before.reads,readState:metrics.readState-before.readState,rootKeyFetches:metrics.status-before.status,signedQueries:metrics.signedQueries-before.signedQueries,jevCalls:metrics.jev-before.jev,rewriteCalls:metrics.rewrite-before.rewrite,maxConcurrentCanisterRequests:metrics.maxActive};
  const requests=(cfg.repeats+1)*cfg.parallel;
  // Fail if a future adapter silently bypasses certificate retrieval or signing.
  assert.equal(result.readState,requests);
  assert.equal(result.rootKeyFetches,requests);
  assert.equal(result.signedQueries,result.queries+result.reads);
  if(!cfg.read){
    assert.equal(result.reads,0);
    assert.equal(result.queries,requests*(cfg.variant==='combined'&&cfg.scenario!=='oversize'?3:1));
    assert.ok(result.maxConcurrentCanisterRequests<=cfg.parallel*2);
  }
  results.push(result);console.log(JSON.stringify({...result,runs:undefined}));
  await writeFile(dir+'resource-results.json',JSON.stringify({completed:false,results,metrics},null,2)+'\n',{mode:0o600});
 }
 await writeFile(dir+'resource-results.json',JSON.stringify({completed:true,signatureVerification:true,integrity,passed:results.every(r=>r.passesGate),results,metrics,note:'Actual private MCP HTTP, review OAuth, SQLite Durable Object, Ed25519 signing, Candid/CBOR and response formatter. Real SDK BLS verification of root/subnet certificates and Ed25519 query signatures enabled; local root key fetched via status. Both corrupt query signatures and corrupt certificates are rejected before measurement. Search candidates simulate producer-side improved previews. The product retrieval pipeline and shared Jev implementation run unchanged except for the local Jev endpoint. Provider replies and network waits are fixture-controlled; live provider quality/latency measured separately. CPU is owned workerd process kernel CPU including DO, not Cloudflare billed isolate CPU. Heap is sampled main-isolate V8 use, not a strict true peak or full isolate-memory measurement.'},null,2)+'\n',{mode:0o600});
 assert.ok(results.every(r=>r.passesGate),'Signed search exceeds local CPU/memory gates; see resource-results.json');
}finally{socket?.close();await mf.dispose();await new Promise(r=>server.close(r));}
