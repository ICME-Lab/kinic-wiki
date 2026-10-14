import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievalSearchHit } from "../src/vfs.js";
const mocks = vi.hoisted(() => ({ factory: vi.fn(), search: vi.fn(), legacy: vi.fn() }));
vi.mock("../src/vfs.js", async original => ({
  ...await original<typeof import("../src/vfs.js")>(), createRetrievalSearcher: mocks.factory, searchNodes: mocks.legacy
}));
import { searchDatabase as rawSearchDatabase } from "../src/index.js";
import { RetrievalSearchUnavailable } from "../src/vfs.js";
import { auxiliaryQueries } from "../src/retrieval-search.js";
import { boundedResponse } from "../src/bounded-response.js";
async function searchDatabase(...args: Parameters<typeof rawSearchDatabase>) {
  const result = await rawSearchDatabase(...args);
  if (!("results" in result)) throw new Error("unexpected tool error");
  return result;
}
const env = { KINIC_WIKI_CANISTER_ID: "aaaaa-aa", MCP_SEARCH_RERANK_ENABLED: "true", TYPESAFE_API_KEY: "private-key" };
const input = { database_id: "db", query: "Hono CORS origin methods", limit: 10 };
const items = (prefix = "original", n = 20): RetrievalSearchHit[] => Array.from({length:n}, (_, i) => ({
  hit: {path:`/${prefix}/private-${i}.md`,kind:"file",score:i,snippet:null,
    preview:{excerpt:"Hono legacy light",matchReason:"content_fts"},matchReasons:["content_fts"]},
  rerankExcerpt:`private body CORS origin methods ${i}`
}));
const model = vi.fn(async (_url: unknown, options?: RequestInit) => {
  const data = JSON.parse(String(options?.body));
  return new Response(JSON.stringify({ answers: Object.fromEntries(data.state.candidates.map((c: {id:string},i:number) => [c.id,{type:"noul",noul:i/20}])) }));
});
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks(); log = vi.spyOn(console,"log").mockImplementation(() => {});
  mocks.factory.mockResolvedValue(mocks.search); mocks.search.mockResolvedValue(items()); mocks.legacy.mockResolvedValue(items().map(i=>i.hit));
  vi.stubGlobal("fetch", model);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("bounded MCP retrieval search", () => {
  for (const limit of [1,10,20]) it(`sorts and returns ${limit} hits without exposing rerank excerpts`, async () => {
    const result = await searchDatabase(env,{...input,limit});
    expect(result.results).toHaveLength(limit);
    expect(result.results[0].metadata.path).toBe("/original/private-19.md");
    expect(result.results[0].metadata.preview).toBe("Hono legacy light");
    expect(mocks.factory).toHaveBeenCalledOnce(); expect(model).toHaveBeenCalledOnce();
    expect(mocks.search).toHaveBeenCalledTimes(3); expect(mocks.legacy).not.toHaveBeenCalled();
    for (const call of mocks.search.mock.calls) expect(call).toEqual(["db",expect.any(String),input.query,"/"]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-|private body|private-key|Hono CORS/);
  });
  it("bounds auxiliary concurrency, deduplicates paths, and tolerates a failed auxiliary search", async () => {
    let active=0,peak=0;
    mocks.search.mockImplementation(async (_db,query) => {
      if(query===input.query)return items();
      active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;
      if(query==="methods")throw new Error("private failure");return items();
    });
    const result=await searchDatabase(env,input);expect(result.results).toHaveLength(10);expect(peak).toBe(2);
    expect(log.mock.calls.map(([entry]: unknown[])=>JSON.parse(String(entry)))).toContainEqual(expect.objectContaining({auxiliaryFailures:1}));
    expect(new Set(result.results.map(r=>r.metadata.path)).size).toBe(10);
    const request=JSON.parse(String(model.mock.calls[0][1]?.body));expect(request.state.candidates).toHaveLength(20);
  });
  it("deduplicates equivalent auxiliary queries", () => {
    expect(auxiliaryQueries("Hono CORS",items().map(i=>({path:i.hit.path,preview:"Hono"})))).toEqual(["cors"]);
  });
  for(const override of [{MCP_SEARCH_RERANK_ENABLED:undefined},{MCP_SEARCH_RERANK_ENABLED:"false"},{TYPESAFE_API_KEY:" "}])
    it(`uses legacy search with disabled or missing configuration ${JSON.stringify(override)}`,async()=>{
      await searchDatabase({...env,...override},input);expect(mocks.factory).not.toHaveBeenCalled();expect(mocks.legacy).toHaveBeenCalledOnce();
    });
  for(const preview_mode of ["none","content-start"] as const)it(`preserves explicit ${preview_mode}`,async()=>{
    await searchDatabase(env,{...input,preview_mode});expect(mocks.factory).not.toHaveBeenCalled();expect(mocks.legacy).toHaveBeenCalledOnce();
  });
  it("keeps long-query compatibility",async()=>{await searchDatabase(env,{...input,query:"😀".repeat(257)});expect(mocks.factory).not.toHaveBeenCalled();});
  it("falls back only for a missing method, not permission or network failures",async()=>{
    mocks.search.mockRejectedValueOnce(new RetrievalSearchUnavailable());await searchDatabase(env,input);expect(mocks.legacy).toHaveBeenCalledOnce();
    mocks.legacy.mockClear();mocks.search.mockRejectedValueOnce(new Error("forbidden"));await expect(searchDatabase(env,input)).rejects.toThrow("forbidden");expect(mocks.legacy).not.toHaveBeenCalled();
  });
  for(const response of [()=>new Response("{}",{status:503}),()=>new Response("{}"),()=>new Response(" ".repeat(65_537))])
    it("returns retrieval order when Jev fails or returns an invalid/oversized body",async()=>{
      model.mockImplementationOnce(async()=>response());const result=await searchDatabase(env,input);
      expect(result.results).toHaveLength(10);expect(result.results[0].metadata.path).toBe("/original/private-0.md");
    });
  it("times out Jev after one attempt",async()=>{
    model.mockImplementationOnce(async(_url,options)=>new Promise((_resolve,reject)=>options?.signal?.addEventListener("abort",()=>reject(new DOMException("aborted","AbortError")))));
    const result=await searchDatabase(env,input);expect(result.results).toHaveLength(10);expect(model).toHaveBeenCalledOnce();
  });
  it("skips Jev for large candidate metadata",async()=>{
    mocks.search.mockResolvedValue(items("x".repeat(2000)));await searchDatabase(env,input);expect(model).not.toHaveBeenCalled();
  });
  it("bounds bytes before decoding, including a lying content-length",async()=>{
    await expect(boundedResponse(new Response("😀".repeat(70_000),{headers:{"content-length":"1"}}),262144)).rejects.toThrow("search_response_size");
  });
});
