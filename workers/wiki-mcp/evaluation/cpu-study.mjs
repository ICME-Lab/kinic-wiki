// Local diagnostic extension of the signed HTTP/OAuth/DO benchmark.
// No production source or verification checks are disabled.
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import assert from 'node:assert/strict';

function normalizeSource(source) {
  const path=source.replaceAll('\\','/');
  const dependency=path.lastIndexOf('node_modules/');
  return dependency<0?path:path.slice(dependency);
}

export function summarizeProfile(profile, bundle) {
  const sources=[];let source='runtime';
  for(const line of bundle.split('\n')) {
    const marker=/^\/\/ (.+\.(?:[cm]?[jt]sx?|json)|<stdin>)$/.exec(line);
    if(marker)source=normalizeSource(marker[1]);
    sources.push(source);
  }
  const nodes=new Map(profile.nodes.map(n=>[n.id,n]));
  const parents=new Map(profile.nodes.flatMap(n=>(n.children??[]).map(id=>[id,n.id])));
  const self=new Map(),categories=new Map();let idleUs=0,excludedGapUs=0;
  for(let i=0;i<(profile.samples??[]).length;i++) {
    const node=nodes.get(profile.samples[i]),us=profile.timeDeltas[i]??0;
    // workerd may stop sampling while waiting for I/O. The next sample then
    // carries the entire gap, incorrectly attributing e.g. 190 ms to one JS
    // frame. Exclude gaps >10 sampling intervals, report them separately.
    // This is diagnostic sampling, never a CPU billing measurement.
    if(us>1000){excludedGapUs+=us;continue;}
    if(['(idle)','(root)'].includes(node.callFrame.functionName)){idleUs+=us;continue;}
    const chain=[];for(let n=node;n;n=nodes.get(parents.get(n.id)))chain.push(n);
    const names=chain.map(n=>n.callFrame.functionName).join(' ');
    const files=chain.map(n=>sources[n.callFrame.lineNumber]??'').join(' ');
    let category='runtime/other';
    if(/blsVerify|pairing|millerLoop|finalExponentiate/.test(names))category='BLS certificate verification';
    else if(/ed25519|abstract\/edwards/.test(files))category='Ed25519 signing/verification';
    else if(/candid\//.test(files))category='Candid encode/decode';
    else if(/cbor/.test(files))category='CBOR encode/decode';
    else if(/(?:^| )node_modules\/(?:zod|zod-to-json-schema)\//.test(files))category='schema validation/construction';
    else if(/retrieval-search/.test(files))category='retrieval candidate processing';
    else if(/jev-reranker/.test(files))category='Jev request/response processing';
    else if(/auth\/(oauth|state|routing)|ii-server/.test(files))category='OAuth/identity';
    else if(/modelcontextprotocol/.test(files))category='MCP transport';
    categories.set(category,(categories.get(category)??0)+us);
    const key=JSON.stringify({function:node.callFrame.functionName||'(anonymous)',source:sources[node.callFrame.lineNumber]??node.callFrame.url,bundleLine:node.callFrame.lineNumber+1});
    self.set(key,(self.get(key)??0)+us);
  }
  return {sampledActiveMs:[...categories.values()].reduce((a,b)=>a+b,0)/1000,idleMs:idleUs/1000,excludedGapMs:excludedGapUs/1000,
    categories:[...categories].map(([category,us])=>({category,ms:us/1000})).sort((a,b)=>b.ms-a.ms),
    topSelf:[...self].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([key,us])=>({...JSON.parse(key),ms:us/1000}))};
}

export function summarizeCpuSamples(samples) {
  assert.ok(samples.length>0&&samples.every(value=>Number.isFinite(value)&&value>=0),'CPU samples must be finite and nonempty');
  const sorted=[...samples].sort((a,b)=>a-b);
  return {samples,sampleCount:samples.length,mean:samples.reduce((a,b)=>a+b,0)/samples.length,
    p50:sorted[Math.ceil(samples.length*.5)-1],p95:sorted[Math.ceil(samples.length*.95)-1],
    max:sorted.at(-1),over10:samples.filter(value=>value>10).length};
}

export function evaluateForwardingBudget({firstSearchCpuMs,integrity,results}) {
  const serial=results.filter(result=>(result.parallel??1)===1);
  const parallel=results.filter(result=>result.parallel>1);
  const within=value=>Number.isFinite(value)&&value>=0&&value<=10;
  return {
    serialRequests:{limitMs:10,caseCount:serial.length,
      passed:serial.length>0&&within(firstSearchCpuMs)&&results.every(result=>within(result.firstCpuMs))&&
        integrity.every(check=>within(check.cpuMs))&&serial.every(result=>
          result.individualCpu?.sampleCount===result.requests&&within(result.individualCpu.max))},
    parallelAverages:{limitMs:10,caseCount:parallel.length,
      passed:parallel.length?parallel.every(result=>within(result.maxTrialMeanMs)):null,
      perRequestBudget:'not_measured_under_concurrency'}
  };
}

export async function runCpuStudy({request,send,cpu,metrics,dir,bundle,integrity,setSignatureFault,delegatedFixture,firstSearchCpuMs,direct,uncached,edgeProcess}) {
  await writeFile(dir+'cpu-study-bundle.mjs',bundle,{mode:0o600});
  const results=[];
  const screen=process.argv.includes('--screen');
  const configurations=screen?[{name:'authenticated-tools-list',variant:'baseline',toolsList:true,limit:10},{name:'retrieval-10',variant:'combined',limit:10}]:process.argv.includes('--focused')?[
    {name:'authenticated-tools-list',variant:'baseline',toolsList:true,limit:10},
    {name:'legacy-10',variant:'baseline',limit:10},
    {name:'retrieval-10',variant:'combined',limit:10},
    {name:'retrieval-20',variant:'combined',limit:20}
  ]:[
    {name:'authenticated-tools-list',variant:'baseline',toolsList:true,limit:10},
    ...[1,10,20].map(limit=>({name:'legacy-'+limit,variant:'baseline',limit})),
    ...[1,10,20].map(limit=>({name:'retrieval-'+limit,variant:'combined',limit})),
    {name:'retrieval-parallel-8',variant:'combined',limit:10,parallel:8},
  ];
  if(process.argv.includes('--reverse'))configurations.reverse();
  const manifest={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    node:process.version,platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model,
    experiment:process.argv.find(a=>a.startsWith('--experiment='))?.slice(13)??'installed-product',screen,
    toolConfiguration:'private (16 registered, 15 model-visible tools)',firstSearchCpuMs,direct,uncached,edgeProcess,
    bundleSha256:createHash('sha256').update(bundle).digest('hex'),signatureVerification:true,
    identityFixture:delegatedFixture?'fixture-seeded encrypted delegation; real DO decrypt, expiry check, identity restoration and request signing; excludes live II login/mint':'review OAuth with real Ed25519 service identity; not a live Internet Identity login',
    measurement:edgeProcess?'separate forwarding workerd process CPU including a local HTTP bridge to the real OAuth/DO/SDK backend; not billed CPU or production topology':'macOS workerd process user+system CPU, including Durable Objects; unprofiled measurements exclude inspector sampling. CDP sampled active time is diagnostic, not billed CPU.',
    provider:'local signed replica and local Jev response, external fixture CPU excluded',
    cacheExperiment:'product endpoint/root-scoped verified-public-key cache; --uncached disables reuse for a diagnostic baseline; identities/actors/results remain request-local'};
  const save=completed=>writeFile(dir+'cpu-study-results.json',JSON.stringify({completed,manifest,integrity,results},null,2)+'\n',{mode:0o600});
  await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:100});
  for(const cfg of configurations) {
    const invoke=()=>request(cfg.variant,'normal',false,cfg);
    const coldStart=cpu();await invoke();const firstCpuMs=cpu()-coldStart;
    for(let warm=0;warm<(screen?10:2);warm++)await invoke();
    const before={...metrics};const trials=[],individualCpuMs=[];const parallel=cfg.parallel??1;
    for(let round=0;round<5;round++) {
      const started=cpu();const responses=[];
      for(let n=0;n<8/parallel;n++) {
        if(parallel===1) {
          const start=cpu();responses.push(await invoke());individualCpuMs.push(cpu()-start);
        } else responses.push(...await Promise.all(Array.from({length:parallel},invoke)));
      }
      trials.push({requests:responses.length,cpuMsPerRequest:(cpu()-started)/responses.length,
        wallMsMean:responses.reduce((s,r)=>s+r.wallMs,0)/responses.length,maxResponseBytes:Math.max(...responses.map(r=>r.bytes))});
    }
    const counts=Object.fromEntries(['queries','readState','status','jev','reads','signedQueries'].map(k=>[k,metrics[k]-before[k]]));
    assert.equal(counts.reads,0);
    assert.equal(counts.queries,cfg.toolsList?0:40*(cfg.variant==='baseline'?1:3));
    assert.equal(counts.signedQueries,counts.queries);
    assert.equal(counts.readState,cfg.toolsList||!uncached?0:40);
    assert.equal(counts.jev,cfg.toolsList||cfg.variant==='baseline'?0:40);
    // Sampling is a separate run so profiler overhead cannot inflate CPU trials.
    let profile;
    if(!screen){await send('Profiler.start');for(let n=0;n<12;n++)await invoke();
      ({profile}=await send('Profiler.stop'));
      await writeFile(dir+cfg.name+'.cpuprofile',JSON.stringify(profile),{mode:0o600});}
    const mean=trials.reduce((s,t)=>s+t.cpuMsPerRequest,0)/trials.length;
    const result={...cfg,firstCpuMs,requests:40,meanCpuMs:mean,
      minTrialMeanMs:Math.min(...trials.map(t=>t.cpuMsPerRequest)),maxTrialMeanMs:Math.max(...trials.map(t=>t.cpuMsPerRequest)),
      individualCpu:parallel===1?summarizeCpuSamples(individualCpuMs):null,
      counts,trials,profile:profile?summarizeProfile(profile,bundle):null};
    results.push(result);await save(false);
    console.log(JSON.stringify({cpuStudy:cfg.name,meanCpuMs:mean,individualMaxCpuMs:result.individualCpu?.max??null,
      perRequestBudget:parallel===1?'measured_serially':'not_measured_under_concurrency',counts,topCategories:result.profile?.categories.slice(0,4)}));
  }
  // Cached public keys must not allow a forged query response through.
  setSignatureFault('query');const modelCalls=metrics.jev;
  let warmFaultCpuMs;
  try {const start=cpu();assert.equal((await request('combined','normal')).error,true);warmFaultCpuMs=cpu()-start;assert.equal(metrics.jev,modelCalls);}
  finally {setSignatureFault(null);}
  integrity.push({fault:'query-with-warm-public-key-cache',rejected:true,cpuMs:warmFaultCpuMs});
  if(edgeProcess) {
    manifest.forwardingBudget=evaluateForwardingBudget({firstSearchCpuMs,integrity,results});
  }
  await save(true);
  if(edgeProcess) {
    assert.ok(manifest.forwardingBudget.serialRequests.passed,'Serial forwarding exceeds 10 ms or lacks individual measurements; see cpu-study-results.json');
    assert.notEqual(manifest.forwardingBudget.parallelAverages.passed,false,'Parallel forwarding average exceeds 10 ms; individual concurrent CPU is not measured');
  }
}
