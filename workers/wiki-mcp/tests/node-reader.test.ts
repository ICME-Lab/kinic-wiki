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
  mocks.createActor.mockImplementation(() => ({ read_node: vi.fn(async (_database: string, path: string) => ({ Ok: [raw(path)] })) }));
});
describe("request-scoped authenticated node reader", () => {
  it("shares one actor within a request across databases and preserves raw content", async () => {
    const identity = {} as Identity;
    const reader = await createNodeReader({ KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_IDENTITY: identity });
    const results = await Promise.all([reader("a", "/first"), reader("b", "/second")]);
    expect(mocks.createActor).toHaveBeenCalledTimes(1);
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({ identity }));
    expect(results.map((value) => value?.content)).toEqual([raw("").content, raw("").content]);
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
