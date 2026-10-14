// Bundle-only trials. Nothing here changes installed libraries or production flags.
import assert from 'node:assert/strict';
const paired=process.argv.includes('--paired');
export const experiments = new Set((process.argv.find(a=>a.startsWith('--experiment='))?.slice(13)??'').split(',').filter(Boolean));
if(paired)for(const name of ['candid','ajv','schema','identity','stream'])experiments.add(name);
const enabled=name=>paired?`globalThis.__wikiCpuExperiment?.has('${name}')`:'true';
for (const name of experiments) assert.ok(['baseline','candid','ajv','schema','identity','stream'].includes(name),`Unknown experiment: ${name}`);
function replace(source, from, to) { assert.ok(source.includes(from),`Experiment anchor missing: ${from}`);return source.replace(from,to); }
export function transformExperiment(path, source) {
 // Reconstruct the pre-experiment baseline only when a trial was requested.
 // The normal benchmark always runs the installed production implementation.
 if(experiments.size&&/candid\/utils\/hash\.js$/.test(path)&&source.includes('// Candid field labels are schema')) {
  source=replace(source,`// Candid field labels are schema, not response values. Bound both the entry
// count and label length so dynamically constructed schemas cannot grow this
// cache indefinitely. Numeric wire labels still take the existing fast path.
const labelHashes = new Map();
const utf8encoder = new TextEncoder();
function idlHash(s) {
    const cached = labelHashes.get(s);
    if (cached !== undefined) return cached;`,`function idlHash(s) {
    const utf8encoder = new TextEncoder();`);
  source=replace(source,`    if (s.length <= 128) {
        if (labelHashes.size >= 512) labelHashes.delete(labelHashes.keys().next().value);
        labelHashes.set(s, h);
    }
`, '');
 }
 if(experiments.size&&/wiki-mcp\/src\/index\.ts$/.test(path)&&source.includes('const sharedJsonSchemaValidator =')) {
  source=replace(source,'import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";\n','');
  source=replace(source,'// This validator owns schema machinery only; requests and identities stay local.\nconst sharedJsonSchemaValidator = new AjvJsonSchemaValidator();\n\n','');
  source=replace(source,'      jsonSchemaValidator: sharedJsonSchemaValidator,\n','');
 }
 if(experiments.has('candid')&&/candid\/utils\/hash\.js$/.test(path)) {
  source=replace(source,'function idlHash(s) {',`const labelHashes = new Map();
const utf8encoder = new TextEncoder();
function idlHash(s) {
    const cacheEnabled = ${enabled('candid')};
    const cached = cacheEnabled ? labelHashes.get(s) : undefined;
    if (cached !== undefined) return cached;`);
  source=replace(source,'    const utf8encoder = new TextEncoder();\n','');
  source=replace(source,'    const array = utf8encoder.encode(s);','    const array = (cacheEnabled ? utf8encoder : new TextEncoder()).encode(s);');
  source=replace(source,'    return h;',`    if (cacheEnabled && s.length <= 128) {
        if (labelHashes.size >= 512) labelHashes.delete(labelHashes.keys().next().value);
        labelHashes.set(s, h);
    }
    return h;`);
 }
 if(experiments.has('ajv')&&/wiki-mcp\/src\/index\.ts$/.test(path)) {
  source=`import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';\nconst sharedValidator = new AjvJsonSchemaValidator();\n`+source;
  source=replace(source,'      instructions:', `      jsonSchemaValidator: ${enabled('ajv')} ? sharedValidator : undefined,\n      instructions:`);
 }
 if(experiments.has('schema')&&/server\/zod-json-schema-compat\.js$/.test(path)) {
  source=replace(source,'export function toJsonSchemaCompat(schema, opts) {',`const schemaJson = new WeakMap();
export function toJsonSchemaCompat(schema, opts) {
    if(!(${enabled('schema')}))return convertJsonSchemaCompat(schema,opts);
    const key=JSON.stringify([opts?.target,opts?.pipeStrategy,opts?.strictUnions]);
    let variants=schemaJson.get(schema);
    const cached=variants?.get(key);
    if(cached)return structuredClone(cached);
    const result=convertJsonSchemaCompat(schema,opts);
    if(!variants){variants=new Map();schemaJson.set(schema,variants);}
    if(variants.size<8)variants.set(key,structuredClone(result));
    return result;
}
function convertJsonSchemaCompat(schema, opts) {`);
 }
 if(experiments.has('identity')&&/ii-server\/internet-identity\.ts$/.test(path)) {
  source=replace(source,'export function restoreKinicIdentity(',`// Trial upper bound: each decrypted material object is fresh per request.
const restoredIdentities = new WeakMap<object, DelegationIdentity>();
export function restoreKinicIdentity(`);
  source=replace(source,'    const chain = DelegationChain.fromJSON(material.delegation);',`    const cached=${enabled('identity')} ? restoredIdentities.get(material) : undefined;
    if(cached)return cached;
    const chain = DelegationChain.fromJSON(material.delegation);`);
  source=replace(source,'    return DelegationIdentity.fromDelegation(restoreIiKey(material.appKey), chain);',`    const identity=DelegationIdentity.fromDelegation(restoreIiKey(material.appKey), chain);
    if(${enabled('identity')})restoredIdentities.set(material,identity);
    return identity;`);
 }
 if(experiments.has('stream')&&/wiki-mcp\/src\/bounded-response\.ts$/.test(path)) {
  const original=source.replace('export async function boundedResponse','async function originalBoundedResponse');
  source=`${original}\nexport function boundedResponse(response: Response, maximum: number): Promise<Response> { return ${enabled('stream')} ? streamBoundedResponse(response,maximum) : originalBoundedResponse(response,maximum); }
async function streamBoundedResponse(response: Response, maximum: number): Promise<Response> {
 if(Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw new Error('search_response_size');}
 if(!response.body)return response;
 const reader=response.body.getReader();let size=0;
 const body=new ReadableStream<Uint8Array>({
  async pull(controller){try{const next=await reader.read();if(next.done){reader.releaseLock();controller.close();return;}
   size+=next.value.byteLength;if(size>maximum){await reader.cancel();throw new Error('search_response_size');}controller.enqueue(next.value);
  }catch(error){reader.releaseLock();controller.error(error);}},
  async cancel(reason){try{await reader.cancel(reason);}finally{reader.releaseLock();}}
 });
 return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}`;
 }
 return source;
}

export async function runPairedExperiments({request,cpu,metrics,dir,bundle}) {
 const {writeFile}=await import('node:fs/promises');
 const {createHash}=await import('node:crypto');
 const {summarizeCpuSamples}=await import('./cpu-study.mjs');
 const final=process.argv.includes('--paired-final');
 const options=final?['','candid,ajv','candid,ajv,schema']:['','candid','ajv','schema','identity','stream','candid,ajv','candid,ajv,schema'];
 const rounds=final?40:8;
 const cases=['search','tools/list'];
 const data=[];
 for(const method of cases){
  const invoke=experiment=>request('combined','normal',false,{experiment,toolsList:method==='tools/list'});
  for(const experiment of options)for(let n=0;n<4;n++)await invoke(experiment);
  const samples=new Map(options.map(name=>[name,[]]));
  const before={...metrics};
  // Alternate forward/reverse order every round, in the same warm process.
  for(let round=0;round<rounds;round++)for(const experiment of (round%2?[...options].reverse():options)){
   const start=cpu();await invoke(experiment);samples.get(experiment).push(cpu()-start);
  }
  const count=options.length*rounds;
  assert.equal(metrics.reads-before.reads,0);
  assert.equal(metrics.readState-before.readState,0);
  assert.equal(metrics.queries-before.queries,method==='search'?count*3:0);
  assert.equal(metrics.signedQueries-before.signedQueries,method==='search'?count*3:0);
  assert.equal(metrics.jev-before.jev,method==='search'?count:0);
  for(const [experiment,values] of samples){const result={method,experiment:experiment||'baseline',...summarizeCpuSamples(values)};data.push(result);console.log(JSON.stringify(result));}
 }
 await writeFile(dir+'paired-experiments.json',JSON.stringify({completed:true,bundleSha256:createHash('sha256').update(bundle).digest('hex'),measurement:'sequential per-request workerd process CPU including DO; not billed CPU',data},null,2)+'\n');
}
