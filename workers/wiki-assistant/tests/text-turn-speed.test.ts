import { afterEach, describe, expect, it, vi } from "vitest";
import { runTextTurn } from "../src/text-turn";
import type { Node } from "../src/kinic";
import { setup } from "./support/text-turn-speed-fixture";

afterEach(() => vi.unstubAllGlobals());
describe("bounded text turn retrieval", () => {
  it("skips empty representatives and reads later documents to fill four evidence slots", async () => {
    const h = setup("database_overview", 6);
    h.nodes[0]!.content = "";
    h.nodes[2]!.content = "";
    const result = await runTextTurn(h.context, h.options);
    expect(result.answer.insufficient).toBe(false);
    expect(h.pending.tools.readPaths).toEqual(h.nodes.filter(node => node.content).map(node => node.path));
    expect(h.pending.tools.evidence).toHaveLength(4);
    expect(h.fetchImpl).toHaveBeenCalledOnce();
  });
  it("returns insufficient evidence when all representatives are empty without exceeding the tool budget", async () => {
    const h = setup("database_overview", 20);
    h.nodes.forEach(node => { node.content = ""; });
    const result = await runTextTurn(h.context, h.options);
    expect(result.answer.insufficient).toBe(true);
    expect(h.pending.tools.evidence).toEqual([]);
    expect(h.pending.tools.calls).toBe(12);
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(h.fetchImpl.mock.calls[0]![1]?.body)).tools).toBeUndefined();
  });
  it("still refuses denied reads when another representative is empty", async () => {
    const h = setup("database_overview", 2);
    h.nodes[0]!.content = "";
    vi.mocked(h.actor.read_node).mockImplementation(async (_db, path) => path === h.nodes[1]!.path
      ? { Err: "denied" } : { Ok: h.nodes.filter(node => node.path === path).slice(0, 1) as [] | [Node] });
    await expect(runTextTurn(h.context, h.options)).rejects.toThrow("wiki_read_denied");
    expect(h.pending.tools.evidence).toEqual([]);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("seeds four overview documents and produces a cited answer with one provider request", async () => {
    const h = setup("database_overview");
    const result = await runTextTurn(h.context, h.options);
    expect(result.answer.citations[0]).toMatchObject({ path: h.nodes[0]!.path, etag: "v0" });
    expect(h.pending.tools.readPaths).toHaveLength(4);
    expect(h.pending.tools.characters).toBeLessThanOrEqual(24000);
    expect(h.pending.tools.calls).toBe(5); // One inventory and four bodies.
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(h.fetchImpl.mock.calls[0]![1]?.body)).tools).toBeUndefined();
    expect(h.context.checkpoint).toHaveBeenCalledTimes(2);
    expect(h.actor.read_node).toHaveBeenCalledTimes(5); // Four bodies plus provider access check.
    expect(h.actor.query_context).not.toHaveBeenCalled();
  });
  it("seeds a selected document while preserving additional read tools for long documents", async () => {
    const h = setup("selected_node_summary");
    const result = await runTextTurn(h.context, h.options);
    expect(result.answer.citations[0]?.path).toBe(h.nodes[0]!.path);
    expect(h.actor.list_nodes).not.toHaveBeenCalled();
    expect(h.pending.tools.readPaths).toEqual([h.nodes[0]!.path]);
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(h.fetchImpl.mock.calls[0]![1]?.body)).tools).toBeDefined();
  });
  it("finishes a small overview without reading nonexistent extra documents", async () => {
    const h = setup("database_overview", 2);
    await runTextTurn(h.context, h.options);
    expect(h.pending.tools.readPaths).toHaveLength(2);
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(h.fetchImpl.mock.calls[0]![1]?.body)).tools).toBeUndefined();
  });
  it("keeps model-directed search rewriting for focused questions", async () => {
    const h = setup("focused_search");
    await runTextTurn(h.context, h.options);
    expect(h.actor.search_nodes).not.toHaveBeenCalled();
    expect(h.actor.list_nodes).not.toHaveBeenCalled();
    expect(h.pending.tools.evidence).toEqual([]);
    expect(JSON.parse(String(h.fetchImpl.mock.calls[0]![1]?.body)).tools).toBeDefined();
  });
  it("does not send prefetched content after provider-boundary authorization fails", async () => {
    const h = setup("database_overview");
    vi.mocked(h.actor.read_node).mockImplementation(async (_db, path) => path === "/Knowledge"
      ? { Err: "denied" } : { Ok: h.nodes.filter(node => node.path === path).slice(0, 1) as [] | [Node] });
    await expect(runTextTurn(h.context, h.options)).rejects.toThrow("wiki_read_denied");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("cancels before retrieval and bounds the prefetch deadline", async () => {
    const h = setup("database_overview");
    vi.mocked(h.context.valid).mockResolvedValue(false);
    await expect(runTextTurn(h.context, h.options)).rejects.toThrow("cancel_requested");
    expect(h.actor.list_nodes).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await expect(runTextTurn(h.context, { ...h.options, deadline: Date.now() - 1 })).rejects.toThrow("turn_timeout");
  });
  it("does not repeat prefetched reads or an ambiguous provider request on recovery", async () => {
    const h = setup("database_overview");
    h.fetchImpl.mockRejectedValueOnce(new Error("network"));
    await expect(runTextTurn(h.context, h.options)).rejects.toThrow("deepseek_request_failed");
    const reads = vi.mocked(h.actor.read_node).mock.calls.length;
    await expect(runTextTurn(h.context, h.options)).rejects.toThrow("deepseek_request_interrupted");
    expect(h.actor.read_node).toHaveBeenCalledTimes(reads);
    expect(h.fetchImpl).toHaveBeenCalledOnce();
  });
});
