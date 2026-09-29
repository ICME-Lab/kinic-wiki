import { describe, expect, it, vi } from "vitest";
import { emptyToolState, KinicReader, type ReadActor } from "../src/kinic";
import { validateAnswer } from "../src/contracts";
import { newDeepSeekTurn, runDeepSeekTurn } from "../src/deepseek";

const final = { answer: "No evidence", citations: [], insufficient: true, contradictions: [], unverified: [] };
const completion = (message: unknown, finish_reason = "stop") => Response.json({ choices: [{ message, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
const answer = () => completion({ role: "assistant", content: JSON.stringify(final) });
const toolMessage = { role: "assistant" as const, content: null, tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "wiki_query", arguments: '{"question":"test","scope":"database"}' } }] };
function setup() {
  return {
    state: newDeepSeekTurn("test"), apiKey: "fake", deadline: Date.now() + 90000,
    authorize: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}),
    execute: vi.fn(async () => '{"hits":[]}'), fetchImpl: vi.fn<typeof fetch>(),
  };
}
describe("DeepSeek text turns", () => {
  it("persists submission before egress and passes read tool results into the next completion", async () => {
    const options = setup();
    const saved: unknown[] = [];
    options.checkpoint.mockImplementation(async () => { saved.push(structuredClone(options.state)); });
    options.fetchImpl.mockImplementationOnce(async (_url, init) => {
      expect(saved.at(-1)).toMatchObject({ requesting: true, rounds: 1 });
      expect(_url).toBe("https://api.deepseek.com/chat/completions");
      expect(init?.redirect).toBe("manual");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" } });
      expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["wiki_query", "wiki_inventory", "wiki_read", "wiki_sources"]);
      return completion(toolMessage, "tool_calls");
    }).mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).messages.at(-1)).toEqual({ role: "tool", tool_call_id: "call-1", content: '{"hits":[]}' });
      return answer();
    });
    expect(await runDeepSeekTurn(options)).toEqual(final);
    expect(options.execute).toHaveBeenCalledExactlyOnceWith("wiki_query", { question: "test", scope: "database" });
    expect(options.state).toMatchObject({ requesting: false, rounds: 2, inputTokens: 20, outputTokens: 6 });
  });
  it("executes actual reader arguments and accepts only its current-turn citation", async () => {
    const options = setup();
    const tools = emptyToolState();
    const path = "/Knowledge/decision.md";
    tools.discoveredPaths.push(path);
    const reader = new KinicReader({
      read_node: async (_db: string, requested: string) => ({ Ok: requested === path ? [{ path, content: "Approved blue.", etag: "v1", metadata_json: "{}", updated_at: 1n }] : [] }),
    } as unknown as ReadActor, "db", "database", tools, 24000, 12, "fake", "selected_node_summary");
    options.fetchImpl.mockResolvedValueOnce(completion({
      role: "assistant", content: null,
      tool_calls: [{ id: "read-1", type: "function", function: { name: "wiki_read", arguments: JSON.stringify({ path, start: 0 }) } }],
    }, "tool_calls")).mockImplementationOnce(async (_url, init) => {
      const evidence = JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content);
      return completion({ role: "assistant", content: JSON.stringify({ ...final, answer: "Blue is approved.", insufficient: false, citations: [{ id: evidence.id, quote: "Approved blue." }] }) });
    });
    const result = await runDeepSeekTurn({ ...options, authorize: () => reader.authorize(), execute: (name, args) => reader.execute(name, args) });
    expect(validateAnswer(result, tools.evidence).citations[0]).toMatchObject({ path, etag: "v1", excerpt: "Approved blue." });
    expect(() => validateAnswer(result, [])).toThrow("invalid_citation");
  });
  it("resumes saved tool outputs without executing them twice", async () => {
    const options = setup();
    options.state.messages.push(toolMessage, { role: "tool", tool_call_id: "call-1", content: "saved" });
    options.fetchImpl.mockResolvedValueOnce(answer());
    await runDeepSeekTurn(options);
    expect(options.execute).not.toHaveBeenCalled();
  });
  it("never resubmits an ambiguous provider request after restart", async () => {
    const options = setup();
    options.fetchImpl.mockRejectedValueOnce(new Error("network with private details"));
    await expect(runDeepSeekTurn(options)).rejects.toThrow("deepseek_request_failed");
    const restarted = { ...options, state: structuredClone(options.state) };
    await expect(runDeepSeekTurn(restarted)).rejects.toThrow("deepseek_request_interrupted");
    expect(options.fetchImpl).toHaveBeenCalledOnce();
  });
  it("uses a saved final answer without another provider request", async () => {
    const options = setup();
    options.state.messages.push({ role: "assistant", content: JSON.stringify(final) });
    expect(await runDeepSeekTurn(options)).toEqual(final);
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });
  it("stops before egress when authorization fails", async () => {
    const options = setup();
    options.authorize.mockRejectedValue(new Error("denied"));
    await expect(runDeepSeekTurn(options)).rejects.toThrow("denied");
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });
  it("discards a provider response when authorization is lost", async () => {
    const options = setup();
    options.fetchImpl.mockImplementation(async () => {
      options.authorize.mockRejectedValue(new Error("cancelled"));
      return completion(toolMessage, "tool_calls");
    });
    await expect(runDeepSeekTurn(options)).rejects.toThrow("cancelled");
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.state.messages).toHaveLength(2);
  });
  it.each([
    ["redirect", () => new Response(null, { status: 302, headers: { Location: "https://example.com" } })],
    ["provider error", () => new Response("private provider error", { status: 503 })],
    ["malformed JSON", () => new Response("not JSON")],
    ["truncation", () => completion({ role: "assistant", content: "{}" }, "length")],
    ["oversize body", () => new Response("x".repeat(256 * 1024 + 1))],
    ["duplicate calls", () => completion({ ...toolMessage, tool_calls: [toolMessage.tool_calls[0], toolMessage.tool_calls[0]] }, "tool_calls")],
  ])("rejects %s with a sanitized failure", async (_name, response) => {
    const options = setup();
    options.fetchImpl.mockResolvedValueOnce(response());
    await expect(runDeepSeekTurn(options)).rejects.toThrow(/^deepseek_/);
    expect(options.execute).not.toHaveBeenCalled();
  });
  it("aborts an active request on cancellation", async () => {
    const options = setup();
    const controller = new AbortController();
    options.fetchImpl.mockImplementation(async (_url, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(runDeepSeekTurn({ ...options, signal: controller.signal })).rejects.toThrow("deepseek_timeout");
    expect(options.state.requesting).toBe(true);
  });
  it("rejects invalid tool JSON before execution", async () => {
    const options = setup();
    options.fetchImpl.mockResolvedValueOnce(completion({ ...toolMessage, tool_calls: [{ ...toolMessage.tool_calls[0], function: { name: "wiki_query", arguments: "{" } }] }, "tool_calls"));
    await expect(runDeepSeekTurn(options)).rejects.toThrow("deepseek_invalid_response");
    expect(options.execute).not.toHaveBeenCalled();
  });
  it("bounds provider rounds and checks deadlines", async () => {
    const options = setup();
    options.state.rounds = 13;
    await expect(runDeepSeekTurn(options)).rejects.toThrow("tool_limit");
    options.deadline = Date.now() - 1;
    await expect(runDeepSeekTurn(options)).rejects.toThrow("turn_timeout");
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });
});
