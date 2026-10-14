import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@icp-sdk/core/agent";
const mocks = vi.hoisted(() => ({ createActor: vi.fn(), createAgent: vi.fn() }));
vi.mock("@icp-sdk/core/agent", async (original) => ({
  ...await original<typeof import("@icp-sdk/core/agent")>(),
  Actor: { createActor: mocks.createActor }, HttpAgent: { createSync: mocks.createAgent }
}));
import { createNodeReader } from "../src/vfs.js";
const raw = (path: string) => ({ path, content: "\uFEFF日本語\u0000😀", kind: { File: null }, created_at: 1n, updated_at: 2n, etag: "etag", metadata_json: "{}" });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAgent.mockReturnValue({});
  mocks.createActor.mockImplementation(() => ({ read_node: vi.fn(async (_database: string, path: string) => ({ Ok: [raw(path)] })), read_nodes: vi.fn(async (_database: string, paths: string[]) => ({ Ok: paths.map((path) => ({ Ok: [raw(path)] })) })) }));
});
describe("request-scoped authenticated node reader", () => {
  it("shares one actor within a request across databases and preserves raw content", async () => {
    const identity = {} as Identity;
    const reader = await createNodeReader({ KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: identity });
    const results = await Promise.all([reader.readOne("a", "/first"), reader.readOne("b", "/second")]);
    expect(mocks.createActor).toHaveBeenCalledTimes(1);
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({ identity }));
    expect(results.map((value) => value?.content)).toEqual([raw("").content, raw("").content]);
  });
  it("uses one batch call and shares that actor with single reads", async () => {
    const reader = await createNodeReader({ KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: {} as Identity });
    const results = await reader.readMany("a", ["/first", "/second"]);
    await reader.readOne("a", "/first");
    expect(results.map((result) => result.node?.content)).toEqual([raw("").content, raw("").content]);
    const actor = mocks.createActor.mock.results[0].value;
    expect(actor.read_nodes).toHaveBeenCalledOnce();
    expect(actor.read_nodes).toHaveBeenCalledWith("a", ["/first", "/second"]);
    expect(mocks.createActor).toHaveBeenCalledOnce();
  });
  it("never shares an authenticated actor between requests or users", async () => {
    const firstIdentity = {} as Identity;
    const secondIdentity = {} as Identity;
    await createNodeReader({ KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: firstIdentity });
    await createNodeReader({ KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: firstIdentity });
    await createNodeReader({ KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: secondIdentity });
    expect(mocks.createActor).toHaveBeenCalledTimes(3);
    expect(mocks.createAgent.mock.calls.map(([options]) => options.identity)).toEqual([firstIdentity, firstIdentity, secondIdentity]);
  });
  it("redacts private actor construction errors", async () => {
    mocks.createAgent.mockImplementationOnce(() => { throw new Error("private identity detail"); });
    await expect(createNodeReader({ KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: {} as Identity })).rejects.toThrow("Kinic Wiki database is unavailable");
  });
});


describe("request-scoped retrieval search client", () => {
  it("shares one actor across auxiliary queries but never across users", async () => {
    const { createRetrievalSearcher } = await import("../src/vfs.js");
    const query = vi.fn(async () => ({ Ok: [] }));
    mocks.createActor.mockReturnValue({ search_nodes_for_retrieval: query });
    const identity = {} as Identity;
    const search = await createRetrievalSearcher({ KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: identity });
    await Promise.all([search("a", "first", "intent", "/"), search("a", "second", "intent", "/")]);
    expect(mocks.createActor).toHaveBeenCalledTimes(1);
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({ identity, retryTimes: 0, fetch: expect.any(Function) }));
    await createRetrievalSearcher({ KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: {} as Identity });
    expect(mocks.createActor).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("redacts private construction errors and rejects unbounded canister output", async () => {
    const { createRetrievalSearcher } = await import("../src/vfs.js");
    mocks.createAgent.mockImplementationOnce(() => { throw new Error("private detail"); });
    await expect(createRetrievalSearcher({ KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: {} as Identity })).rejects.toThrow("Kinic Wiki database is unavailable");
    mocks.createActor.mockReturnValue({ search_nodes_for_retrieval: async () => ({Ok:Array(21).fill({})}) });
    const search = await createRetrievalSearcher({KINIC_WIKI_CANISTER_ID:"aaaaa-aa"});
    await expect(search("db","q","q","/")).rejects.toThrow("invalid_retrieval_response");
  });
});

it("distinguishes a replica missing-method reject from a private application error", async () => {
  const { RejectError, UncertifiedRejectErrorCode } = await import("@icp-sdk/core/agent");
  const { createRetrievalSearcher, RetrievalSearchUnavailable } = await import("../src/vfs.js");
  const missing = new RejectError(new UncertifiedRejectErrorCode(new Uint8Array(32) as import("@icp-sdk/core/agent").RequestId, 3,
    "Canister has no query method 'search_nodes_for_retrieval'", "IC0536", undefined));
  const query = vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce({Err:"private database denied: search_nodes_for_retrieval"});
  mocks.createActor.mockReturnValue({search_nodes_for_retrieval:query});
  const search = await createRetrievalSearcher({KINIC_WIKI_CANISTER_ID:"aaaaa-aa",KINIC_WIKI_IDENTITY:{} as Identity});
  await expect(search("db","q","q","/")).rejects.toBeInstanceOf(RetrievalSearchUnavailable);
  await expect(search("db","q","q","/")).rejects.toThrow("Kinic Wiki database is unavailable");
});
