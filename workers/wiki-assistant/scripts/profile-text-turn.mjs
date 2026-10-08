// Local synthetic workerd CPU sampling; no provider calls, keys or private Wiki.
// Samples are not Cloudflare's billed CPU time or proof of a production limit.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const require = createRequire(new URL("../package.json", import.meta.url));
const { build } = createRequire(require.resolve("wrangler"))("esbuild");
const { Miniflare } = createRequire(import.meta.resolve("@cloudflare/vitest-pool-workers"))("miniflare");
const project = fileURLToPath(new URL("..", import.meta.url));
const entry = String.raw`
import { emptyToolState, KinicReader } from "./src/kinic.ts";
import { newDeepSeekTurn, runDeepSeekTurn } from "./src/deepseek.ts";
import { seedTextContext } from "./src/seed-text-context.ts";
import { prefetchSearchReads } from "./src/prefetch-search.ts";
import { encryptJson } from "@kinic/ii-server/crypto";
import { validateAnswer } from "./src/contracts.ts";
import { IDL } from "@icp-sdk/core/candid";
import { readIdlFactory } from "@kinic/ii-server/read";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const readTypes = readIdlFactory({IDL}).fieldsAsObject().read_node.retTypes;
const packedNodes = new Map();
export default { async fetch(request) {
  const url = new URL(request.url);
  if(url.pathname === "/warmup") return new Response("ready");
  const optimized = url.searchParams.get("mode") === "optimized";
  const focused = url.searchParams.get("scenario") === "focused";
  const candidBytes = Number(url.searchParams.get("candidBytes") || 0);
  const historyCount = Number(url.searchParams.get("history") || 0);
  const tools = emptyToolState(), state = newDeepSeekTurn("Summarize this database");
  const metrics = { readRequests: 0, providerRequests: 0, checkpoints: 0, encryptedValues: 0, maxConcurrentReads: 0 };
  let active = 0;
  const nodes = Array.from({length:4},(_,i)=>({path:"/Knowledge/overview-"+i+".md", content:"Verified document "+i+". "+"x".repeat(candidBytes || 4000),etag:"v"+i,metadata_json:"{}",updated_at:1n}));
  const actor = {
    async read_node(_db,path) {
      metrics.readRequests++; metrics.maxConcurrentReads = Math.max(metrics.maxConcurrentReads,++active);
      try {
        await pause();
        const result={Ok:nodes.filter(node=>node.path===path)};
        if(!candidBytes) return result;
        const cacheKey=candidBytes+":"+path;
        if(!packedNodes.has(cacheKey)) packedNodes.set(cacheKey,IDL.encode(readTypes,[result]));
        return IDL.decode(readTypes,packedNodes.get(cacheKey))[0];
      } finally { active--; }
    },
    async list_nodes({prefix}) {await pause();return {Ok:prefix==="/Knowledge"?nodes.map(node=>({...node,kind:{File:null},has_children:false})):[]};},
    async source_evidence({node_path}) {return {Ok:{node_path,refs:[]}};}
  };
  const route = focused ? "focused_search" : "database_overview";
  const reader = new KinicReader(actor,"synthetic","database",tools,24000,12,"",route,false);
  const execute = async(name,args) => {
    if(focused && name === "wiki_query") {
      await pause(); tools.calls++;
      tools.discoveredPaths.push(...nodes.slice(0,2).map(node=>node.path));
      const output=JSON.stringify({nodes:nodes.slice(0,2).map(node=>({path:node.path}))});
      tools.characters+=output.length;
      return output;
    }
    return reader.execute(name,args);
  };
  const history = Array.from({length:historyCount},(_,i)=>({requestId:String(i),question:"Question",answer:"x".repeat(800)}));
  const checkpoint = async()=> {
    metrics.checkpoints++;
    await encryptJson(state,key,"conversation"); metrics.encryptedValues++;
    for(const message of history) {await encryptJson(message,key,"history:"+message.requestId);metrics.encryptedValues++;}
  };
  const fetchImpl = async(_url,init)=> {
    metrics.providerRequests++; await pause();
    const messages = JSON.parse(String(init.body)).messages;
    const outputs = messages.filter(message=>message.role==="tool").map(message=>JSON.parse(message.content));
    let message,finish_reason="stop";
    const evidence = outputs.filter(output=>output.id);
    if(focused && !outputs.length) {
      finish_reason="tool_calls";message={role:"assistant",content:null,tool_calls:[{id:"search",type:"function",function:{name:"wiki_query",arguments:JSON.stringify({question:"synthetic focused question",scope:"database"})}}]};
    } else if(!optimized && !outputs.length) {
      finish_reason="tool_calls";message={role:"assistant",content:null,tool_calls:[{id:"inventory",type:"function",function:{name:"wiki_inventory",arguments:"{}"}}]};
    } else if(!evidence.length) {
      finish_reason="tool_calls";message={role:"assistant",content:null,tool_calls:(focused?nodes.slice(0,2):nodes).map((node,i)=>({id:"read"+i,type:"function",function:{name:"wiki_read",arguments:JSON.stringify({path:node.path,start:0})}}))};
    } else message={role:"assistant",content:JSON.stringify({answer:"A grounded summary",citations:[{id:evidence[0].id,quote:evidence[0].excerpt.slice(0,20)}],insufficient:false,contradictions:[],unverified:[]})};
    return Response.json({choices:[{finish_reason,message}]});
  };
  const before=Date.now();
  if(optimized && !focused) await seedTextContext({route,subject:{kind:"database"},requestId:"synthetic",state,reader,checkActive:async()=>{}});
  const result = await runDeepSeekTurn({state,apiKey:"synthetic",scope:"database",route,deadline:Date.now()+90000,
    authorize:()=>reader.authorize(),checkpoint,execute,fetchImpl,
    ...(optimized || focused?{checkActive:async()=>{},executeReadBatch:args=>reader.executeReadBatch(args),canUseTools:()=>focused}:{}),
    ...(focused && optimized ? {prefetchReads:messages=>prefetchSearchReads(messages,reader),executePrefetchBatch:args=>reader.executeReadBatch(args,{skipEmpty:true})}:{})});
  const answer=validateAnswer(result,tools.evidence);
  return Response.json({...metrics,wallMs:Date.now()-before,characters:tools.characters,citations:answer.citations.length,scenario:focused?"focused":"overview",candidBytes});
}};`;
const built = await build({ stdin: { contents: entry, resolveDir: project, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["node:*"] });
const rows = [];
const scenario = process.env.ASKAI_PROFILE_SCENARIO === "focused" ? "focused" : "overview";
const candidBytes = Number(process.env.ASKAI_PROFILE_CANDID_BYTES || 0);
if(!Number.isSafeInteger(candidBytes) || candidBytes < 0 || candidBytes > 1024*1024)
  throw new Error("Candid fixture size must be an integer from 0 to 1048576");
const processCpuRows = [];
const ownedProcessCpu = () => {
  if (process.platform !== "darwin") return undefined;
  // Only the workerd child of this benchmark; never inspect other app processes.
  const pid = execFileSync("pgrep", ["-P", String(process.pid), "-x", "workerd"], { encoding: "utf8" }).trim();
  if (!/^\d+$/.test(pid)) throw new Error("Expected one owned workerd process");
  // Darwin rusage CPU counters are Mach ticks, as in XNU's recount tests.
  const code = `import ctypes,struct,sys
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
system=ctypes.CDLL('/usr/lib/libSystem.B.dylib')
lib.proc_pid_rusage.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_void_p]
b=ctypes.create_string_buffer(1024)
assert lib.proc_pid_rusage(int(sys.argv[1]),0,ctypes.byref(b))==0
timebase=(ctypes.c_uint32*2)()
assert system.mach_timebase_info(ctypes.byref(timebase))==0
ticks=sum(struct.unpack_from('QQ',b.raw,16))
print(ticks*int(timebase[0])//int(timebase[1]))`;
  return Number(execFileSync("python3", ["-c", code, pid], { encoding: "utf8" }).trim()) / 1e6;
};
for (const history of [0, 20]) for (const mode of ["legacy", "optimized"]) {
  const runtime = new Miniflare({ name: "speed-profile", modules: true, script: built.outputFiles[0].text,
    compatibilityDate: "2026-08-08", compatibilityFlags: ["nodejs_compat"], inspectorPort: 0 });
  let socket;
  try {
    await runtime.dispatchFetch("http://bench/warmup");
    const inspector = await runtime.getInspectorURL(); inspector.protocol = "http:"; inspector.pathname = "/json";
    const targets = await (await fetch(inspector)).json();
    socket = new WebSocket(targets.find(target => target.id.includes("speed-profile"))?.webSocketDebuggerUrl ?? targets[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data)), item = pending.get(reply.id);
      if (item) { pending.delete(reply.id); reply.error ? item.reject(new Error(reply.error.message)) : item.resolve(reply.result); }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    await send("Profiler.enable"); await send("Profiler.setSamplingInterval", { interval: 100 });
    for (let iteration = 0; iteration < 6; iteration++) {
      await send("Profiler.start");
      const response = await runtime.dispatchFetch("http://bench/run?mode="+mode+"&history="+history+"&scenario="+scenario+"&candidBytes="+candidBytes);
      if (!response.ok) throw new Error("Synthetic request failed: "+response.status);
      const metrics = await response.json();
      const { profile } = await send("Profiler.stop");
      const names = new Map(profile.nodes.map(node => [node.id, node.callFrame.functionName]));
      const sampledJavaScriptUs = (profile.samples ?? []).reduce((total, id, index) =>
        total + (["(idle)", "(root)", "(program)"].includes(names.get(id)) ? 0 : (profile.timeDeltas[index] ?? 0)), 0);
      rows.push({ mode, history, iteration, sampledJavaScriptMs: sampledJavaScriptUs / 1000, ...metrics });
    }
    // Separate runs with the profiler stopped: kernel process CPU excludes I/O
    // waits and includes native crypto, unlike JavaScript stack sampling.
    if (process.platform === "darwin") for (let iteration = 0; iteration < 5; iteration++) {
      const before = ownedProcessCpu();
      const response = await runtime.dispatchFetch("http://bench/run?mode="+mode+"&history="+history+"&scenario="+scenario+"&candidBytes="+candidBytes);
      if (!response.ok) throw new Error("Synthetic CPU request failed: "+response.status);
      await response.json();
      processCpuRows.push({ mode, history, iteration, workerdProcessCpuMs: ownedProcessCpu() - before });
    }
  } finally { socket?.close(); await runtime.dispose(); }
}
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const summary = [0,20].flatMap(history => ["legacy","optimized"].map(mode => {
  const matching=rows.filter(row=>row.mode===mode&&row.history===history), warm=matching.slice(1);
  return { scenario,candidBytes,mode,history,coldSampledJavaScriptMs:matching[0].sampledJavaScriptMs,
    warmMedianSampledJavaScriptMs:median(warm.map(row=>row.sampledJavaScriptMs)), warmMedianWallMs:median(warm.map(row=>row.wallMs)),
    warmMedianWorkerdProcessCpuMs: processCpuRows.length ? median(processCpuRows.filter(row=>row.mode===mode&&row.history===history).map(row=>row.workerdProcessCpuMs)) : undefined,
    readRequests:warm[0].readRequests,providerRequests:warm[0].providerRequests,checkpoints:warm[0].checkpoints,
    encryptedValues:warm[0].encryptedValues,maxConcurrentReads:warm[0].maxConcurrentReads };
}));
const report = { note: "Synthetic local workerd benchmark, not Cloudflare billed CPU. V8 stack samples can include paused frames and omit native crypto; do not compare them to the 10ms limit. Darwin kernel CPU measurements run separately with the profiler stopped and include the owned workerd process's native work. IC transport/signing, Jev, D1 latency and real model latency are not exercised. Nonzero candidBytes exercises the actual read_node Candid return type: cold runs include fixture encoding, warm runs reuse packed replies and decode them on each read. Focused scenario mocks ranked search results, comparing main-style adjacent batched reads with prefetch. Overview legacy preserves sequential tool/auth/checkpoint behavior. Each synthetic checkpoint rewrites all fixture history; actual incremental persistence is not represented.", summary, rows, processCpuRows };
if(process.env.ASKAI_PROFILE_OUTPUT) await writeFile(process.env.ASKAI_PROFILE_OUTPUT, JSON.stringify(report,null,2));
console.log(JSON.stringify({note:report.note,summary},null,2));
