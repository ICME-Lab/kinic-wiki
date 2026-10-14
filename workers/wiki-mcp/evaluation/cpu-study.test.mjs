import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateForwardingBudget,summarizeCpuSamples,summarizeProfile} from './cpu-study.mjs';

test('I/O suspension cannot appear as CPU spent parsing a Jev response',()=>{
  const profile={nodes:[
    {id:1,callFrame:{functionName:'(root)',lineNumber:-1},children:[2,3]},
    {id:2,callFrame:{functionName:'readBoundedJson',lineNumber:1}},
    {id:3,callFrame:{functionName:'(idle)',lineNumber:-1}}
  ],samples:[2,2,3],timeDeltas:[190000,100,100]};
  const result=summarizeProfile(profile,'// ../../packages/jev-reranker/index.ts\nfunction readBoundedJson() {}');
  assert.equal(result.excludedGapMs,190);
  assert.equal(result.sampledActiveMs,.1);
  assert.equal(result.idleMs,.1);
  assert.deepEqual(result.categories,[{category:'Jev request/response processing',ms:.1}]);
});

test('shared finite-field operations are attributed to their BLS caller',()=>{
  const profile={nodes:[
    {id:1,callFrame:{functionName:'(root)',lineNumber:-1},children:[2]},
    {id:2,callFrame:{functionName:'blsVerify',lineNumber:1},children:[3]},
    {id:3,callFrame:{functionName:'mul',lineNumber:3}}
  ],samples:[3],timeDeltas:[100]};
  const bundle='// ../../node_modules/core/agent/utils/bls.js\nfunction blsVerify() {}\n// ../../node_modules/curves/abstract/tower.js\nfunction mul() {}';
  const result=summarizeProfile(profile,bundle);
  assert.deepEqual(result.categories,[{category:'BLS certificate verification',ms:.1}]);
  assert.equal(result.topSelf[0].source,'node_modules/curves/abstract/tower.js');
});

test('pnpm peer names cannot classify MCP or project routing as Zod',()=>{
  const bundle=[
    '// node_modules/.pnpm/@modelcontextprotocol+sdk@1.31.0_zod@4.4.3/node_modules/@modelcontextprotocol/sdk/server/mcp.js',
    'function handleRequest() {}',
    '// workers/wiki-mcp/src/auth/routing.ts',
    'function parseRoutedToken() {}',
    '// node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/parse.js',
    'function parse() {}'
  ].join('\n');
  const profile={nodes:[
    {id:1,callFrame:{functionName:'(root)',lineNumber:-1},children:[2,3,4]},
    {id:2,callFrame:{functionName:'handleRequest',lineNumber:1}},
    {id:3,callFrame:{functionName:'parseRoutedToken',lineNumber:3}},
    {id:4,callFrame:{functionName:'parse',lineNumber:5}}
  ],samples:[2,3,4],timeDeltas:[100,100,100]};
  const result=summarizeProfile(profile,bundle);
  assert.deepEqual(result.categories,[
    {category:'MCP transport',ms:.1},
    {category:'OAuth/identity',ms:.1},
    {category:'schema validation/construction',ms:.1}
  ]);
  assert.equal(result.topSelf[1].source,'workers/wiki-mcp/src/auth/routing.ts');
});

const serialCase=(name,samples)=>({name,requests:samples.length,firstCpuMs:1,
  maxTrialMeanMs:samples.reduce((a,b)=>a+b,0)/samples.length,individualCpu:summarizeCpuSamples(samples)});

test('an over-budget request fails even when its trial average passes',()=>{
  const results=[serialCase('retrieval-10',Array(8).fill(1)),serialCase('retrieval-20',[40,...Array(7).fill(1)])];
  assert.ok(results[1].maxTrialMeanMs<10);
  assert.equal(results[1].individualCpu.over10,1);
  assert.equal(evaluateForwardingBudget({firstSearchCpuMs:1,integrity:[{cpuMs:1}],results}).serialRequests.passed,false);
});

test('parallel averages never assert individual concurrent CPU compliance',()=>{
  const results=[serialCase('retrieval-10',Array(40).fill(1)),
    {name:'retrieval-parallel-8',parallel:8,requests:40,firstCpuMs:1,maxTrialMeanMs:5.875,individualCpu:null}];
  const budget=evaluateForwardingBudget({firstSearchCpuMs:1,integrity:[{cpuMs:1}],results});
  assert.equal(budget.serialRequests.passed,true);
  assert.equal(budget.parallelAverages.passed,true);
  assert.equal(budget.parallelAverages.perRequestBudget,'not_measured_under_concurrency');
  assert.equal(Object.hasOwn(budget,'passed'),false);
  results[1].maxTrialMeanMs=11;
  assert.equal(evaluateForwardingBudget({firstSearchCpuMs:1,integrity:[],results}).parallelAverages.passed,false);
});

test('missing individual samples and unmeasured integrity cases cannot pass',()=>{
  const full=serialCase('legacy-1',Array(40).fill(1));
  const input={firstSearchCpuMs:1,integrity:[{cpuMs:1}],results:[full]};
  assert.equal(evaluateForwardingBudget(input).serialRequests.passed,true);
  assert.equal(evaluateForwardingBudget({...input,results:[{...full,individualCpu:null}]}).serialRequests.passed,false);
  assert.equal(evaluateForwardingBudget({...input,results:[{...full,requests:41}]}).serialRequests.passed,false);
  assert.equal(evaluateForwardingBudget({...input,integrity:[{}]}).serialRequests.passed,false);
});

test('individual CPU summaries reject unavailable measurements',()=>{
  assert.throws(()=>summarizeCpuSamples([]));
  assert.throws(()=>summarizeCpuSamples([1,NaN]));
  assert.throws(()=>summarizeCpuSamples([-1]));
  const summary=summarizeCpuSamples([1,2,3,4,11]);
  assert.equal(summary.p95,11);
  assert.equal(summary.max,11);
  assert.equal(summary.over10,1);
});
