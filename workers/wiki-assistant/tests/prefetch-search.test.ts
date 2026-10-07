import { afterEach, describe, expect, it, vi } from "vitest";
import { runTextTurn } from "../src/text-turn";
import { prefetchSearchReads } from "../src/prefetch-search";
import type { ChatMessage } from "../src/deepseek";
import { setup } from "./support/text-turn-speed-fixture";

afterEach(() => vi.unstubAllGlobals());
function focused() {
  const h = setup("focused_search");
  const execute = h.reader.execute.bind(h.reader);
  vi.spyOn(h.reader, "execute").mockImplementation(async (name, args) => {
    if (name !== "wiki_query") return execute(name, args);
    h.pending.tools.calls++;
    h.pending.tools.discoveredPaths.push(...h.nodes.map(node => node.path));
    return JSON.stringify({ nodes: h.nodes.map(node => ({ path: node.path })) });
  });
  h.fetchImpl.mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "tool_calls", message: {
    role: "assistant", content: null, tool_calls: [{ id: "search-1", type: "function", function: {
      name: "wiki_query", arguments: JSON.stringify({ question: "rewritten question", scope: "database" }),
    } }],
  } }] }));
  return h;
}
describe("focused retrieval prefetch", () => {
  it("repairs a received answer missing a required field once without discarding evidence", async () => {
    const h = setup("selected_node_summary");
    h.fetchImpl.mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "stop", message: {
      role: "assistant", content: JSON.stringify({ answer: "Missing flag", citations: [], contradictions: [], unverified: [] }),
    } }] }));
    const result = await runTextTurn(h.context, h.options);
    expect(result.answer.insufficient).toBe(false);
    expect(result.answer.citations[0]?.path).toBe(h.nodes[0]!.path);
    expect(h.pending.deepseek?.finalRepairs).toBe(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(h.fetchImpl.mock.calls[1]![1]?.body)).tools).toBeUndefined();
  });
  it("fails closed after a second malformed answer and never repeats an ambiguous repair submission", async () => {
    const invalid = () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }] });
    const h = setup("focused_search");
    h.fetchImpl.mockImplementation(async () => invalid());
    await expect(runTextTurn(h.context, h.options)).rejects.toThrow("deepseek_invalid_response");
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    const ambiguous = setup("focused_search");
    ambiguous.fetchImpl.mockResolvedValueOnce(invalid()).mockRejectedValueOnce(new Error("network"));
    await expect(runTextTurn(ambiguous.context, ambiguous.options)).rejects.toThrow("deepseek_request_failed");
    await expect(runTextTurn(ambiguous.context, ambiguous.options)).rejects.toThrow("deepseek_request_interrupted");
    expect(ambiguous.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("keeps the model query and supplies two cited bodies before the second provider round", async () => {
    const h = focused();
    const result = await runTextTurn(h.context, h.options);
    expect(result.answer.insufficient).toBe(false);
    expect(h.reader.execute).toHaveBeenCalledWith("wiki_query", { question: "rewritten question", scope: "database" });
    expect(h.pending.tools.readPaths).toEqual(h.nodes.slice(0, 2).map(node => node.path));
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.providerRounds).toBe(2);
    expect(result.providerDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.retrievalDurationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(String(h.fetchImpl.mock.calls[1]![1]?.body)).tools).toBeDefined();
  });
  it("resumes checkpointed synthetic reads without rerunning search or planning more reads", async () => {
    const h = focused();
    let interrupted = false;
    vi.mocked(h.context.checkpoint).mockImplementation(async () => {
      const last = h.pending.deepseek?.messages.at(-1);
      if (!interrupted && last?.role === "assistant" && last.tool_calls?.[0]?.id.startsWith("prefetch-read-")) {
        interrupted = true;
        throw new Error("storage interrupted");
      }
    });
    await expect(runTextTurn(h.context, h.options)).rejects.toThrow("storage interrupted");
    expect(h.pending.tools.readPaths).toEqual([]);
    const result = await runTextTurn(h.context, h.options);
    expect(result.answer.insufficient).toBe(false);
    expect(h.pending.tools.readPaths).toHaveLength(2);
    expect(h.reader.execute).toHaveBeenCalledTimes(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("skips an empty ranked document but fails closed on a denied read", async () => {
    const h = focused();
    h.nodes[0]!.content = "";
    expect((await runTextTurn(h.context, h.options)).answer.insufficient).toBe(false);
    expect(h.pending.tools.readPaths).toEqual([h.nodes[1]!.path]);
    const denied = focused();
    vi.mocked(denied.actor.read_node).mockImplementation(async (_db, path) => path === "/Knowledge"
      ? { Ok: [] } : { Err: "denied" });
    await expect(runTextTurn(denied.context, denied.options)).rejects.toThrow("wiki_read_denied");
    expect(denied.fetchImpl).toHaveBeenCalledTimes(1);
    expect(denied.pending.tools.evidence).toEqual([]);
  });
  it("reports an empty model-directed search hit without inventing evidence or discarding another body", async () => {
    const h = setup("focused_search");
    h.nodes[0]!.content = "";
    h.pending.tools.discoveredPaths.push(...h.nodes.map(node => node.path));
    const outputs = await h.reader.executeReadBatch(h.nodes.slice(0, 2).map(node => ({ path: node.path, start: 0 })));
    expect(JSON.parse(outputs[0]!)).toEqual({ path: h.nodes[0]!.path, error: "empty_document" });
    expect(JSON.parse(outputs[1]!).path).toBe(h.nodes[1]!.path);
    expect(h.pending.tools.evidence).toHaveLength(1);
    expect(h.pending.tools.calls).toBe(2);
  });
  it("does not send prefetched private evidence after authorization is revoked", async () => {
    const h = focused();
    const read = h.actor.read_node;
    vi.mocked(read).mockImplementation(async (_db, path) => path === "/Knowledge" && h.pending.tools.evidence.length
      ? { Err: "denied" } : { Ok: h.nodes.filter(node => node.path === path).slice(0, 1) as [] | [typeof h.nodes[number]] });
    await expect(runTextTurn(h.context, h.options)).rejects.toThrow("wiki_read_denied");
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("respects discovery, duplicate reads, remaining budgets, and subsequent searches", () => {
    const h = setup("focused_search");
    h.pending.tools.discoveredPaths.push(...h.nodes.map(node => node.path));
    h.pending.tools.readPaths.push(h.nodes[0]!.path);
    const messages: ChatMessage[] = [{ role: "assistant", tool_calls: [{ id: "q", type: "function",
      function: { name: "wiki_query", arguments: "{}" } }] }, { role: "tool", tool_call_id: "q",
      content: JSON.stringify({ nodes: [{ path: "/undiscovered.md" }, ...h.nodes.map(node => ({ path: node.path })), { path: h.nodes[1]!.path }] }) }];
    expect(prefetchSearchReads(messages, h.reader)).toEqual(h.nodes.slice(1, 3).map(node => ({ path: node.path, start: 0 })));
    h.pending.tools.calls = 11;
    expect(prefetchSearchReads(messages, h.reader)).toHaveLength(1);
    h.pending.tools.characters = 20000;
    expect(prefetchSearchReads(messages, h.reader)).toEqual([]);
    h.pending.tools.characters = 0;
    messages.push({ role: "assistant", tool_calls: [{ id: "q2", type: "function", function: { name: "wiki_query", arguments: "{}" } }] });
    expect(prefetchSearchReads(messages, h.reader)).toEqual([]);
  });
  it("interleaves Jev results for simultaneous initial queries without enabling later searches", () => {
    const h = setup("focused_search");
    h.pending.tools.discoveredPaths.push(...h.nodes.map(node => node.path));
    const calls = ["q1", "q2"].map(id => ({ id, type: "function" as const, function: { name: "wiki_query", arguments: "{}" } }));
    const messages: ChatMessage[] = [{ role: "assistant", tool_calls: calls },
      { role: "tool", tool_call_id: "q1", content: JSON.stringify({ nodes: h.nodes.slice(0, 2).map(node => ({ path: node.path })) }) },
      { role: "tool", tool_call_id: "q2", content: JSON.stringify({ nodes: h.nodes.slice(2).map(node => ({ path: node.path })) }) }];
    expect(prefetchSearchReads(messages, h.reader)).toEqual([0, 2].map(index => ({ path: h.nodes[index]!.path, start: 0 })));
  });
});
