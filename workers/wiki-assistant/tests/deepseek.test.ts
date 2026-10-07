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
    state: newDeepSeekTurn("test"), apiKey: "fake", scope: "database" as const, deadline: Date.now() + 90000,
    authorize: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}),
    execute: vi.fn(async (_name: string, _args: unknown) => '{"hits":[]}'), fetchImpl: vi.fn<typeof fetch>(),
  };
}
describe("DeepSeek text turns", () => {
  it("recovers a received whitespace response once and retains usage without repeating retrieval", async () => {
    const options = setup();
    options.fetchImpl.mockResolvedValueOnce(completion({ role: "assistant", content: "   \n " }))
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages.at(-1).content).toContain("nonempty JSON object");
        expect(options.state.requesting).toBe(true);
        return answer();
      });
    expect(await runDeepSeekTurn(options)).toEqual(final);
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.state).toMatchObject({ whitespaceRecoveries: 1, inputTokens: 20, outputTokens: 6 });
  });
  it("does not retry a second whitespace response", async () => {
    const options = setup();
    options.fetchImpl.mockImplementation(async () => completion({ role: "assistant", content: " " }));
    await expect(runDeepSeekTurn(options)).rejects.toThrow("deepseek_invalid_response");
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("resumes a persisted recovery prompt without allowing another recovery", async () => {
    const options = setup();
    options.fetchImpl.mockResolvedValueOnce(completion({ role: "assistant", content: " " }));
    let saved: typeof options.state | undefined;
    options.checkpoint.mockImplementation(async () => {
      if (options.state.whitespaceRecoveries && options.state.messages.at(-1)?.role === "user") {
        saved = structuredClone(options.state);
        throw new Error("restart");
      }
    });
    await expect(runDeepSeekTurn(options)).rejects.toThrow("restart");
    expect(saved).toBeDefined();
    const restarted = { ...options, state: saved!, checkpoint: vi.fn(async () => {}), fetchImpl: vi.fn<typeof fetch>(async () => answer()) };
    expect(await runDeepSeekTurn(restarted)).toEqual(final);
    expect(restarted.fetchImpl).toHaveBeenCalledOnce();
    expect(restarted.state.whitespaceRecoveries).toBe(1);
  });
  it("does not repeat an ambiguous recovery submission", async () => {
    const options = setup();
    options.fetchImpl.mockResolvedValueOnce(completion({ role: "assistant", content: " " }))
      .mockRejectedValueOnce(new Error("connection_lost"));
    await expect(runDeepSeekTurn(options)).rejects.toThrow("deepseek_request_failed");
    expect(options.state.requesting).toBe(true);
    await expect(runDeepSeekTurn(options)).rejects.toThrow("deepseek_request_interrupted");
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("rechecks authorization before the recovery provider request", async () => {
    const options = setup();
    options.fetchImpl.mockResolvedValueOnce(completion({ role: "assistant", content: " " }));
    options.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("access_revoked"));
    await expect(runDeepSeekTurn({ ...options, checkActive: async () => {} })).rejects.toThrow("access_revoked");
    expect(options.fetchImpl).toHaveBeenCalledOnce();
  });
  it("batches two adjacent body reads, preserves output order and saves one checkpoint", async () => {
    const options = setup(), checkActive = vi.fn(async () => {});
    const executeReadBatch = vi.fn(async () => ["first", "second"]);
    const calls = ["one", "two"].map((id) => ({ id, type: "function", function: {
      name: "wiki_read", arguments: JSON.stringify({ path: "/Knowledge/" + id, start: 0 }),
    } }));
    options.fetchImpl.mockResolvedValueOnce(completion({ role: "assistant", content: null, tool_calls: calls }, "tool_calls"))
      .mockImplementationOnce(async (_url, init) => {
        expect(JSON.parse(String(init?.body)).messages.slice(-2)).toEqual([
          { role: "tool", tool_call_id: "one", content: "first" },
          { role: "tool", tool_call_id: "two", content: "second" },
        ]);
        return answer();
      });
    await runDeepSeekTurn({ ...options, executeReadBatch, checkActive });
    expect(executeReadBatch).toHaveBeenCalledExactlyOnceWith([
      { path: "/Knowledge/one", start: 0 }, { path: "/Knowledge/two", start: 0 },
    ]);
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.checkpoint).toHaveBeenCalledTimes(5);
    expect(options.authorize).toHaveBeenCalledTimes(2); // Before each provider request.
    expect(checkActive).toHaveBeenCalled();
  });
  it("caps body batches at two and keeps non-read dependencies sequential", async () => {
    const options = setup();
    const executeReadBatch = vi.fn(async (args: unknown[]) => args.map(() => "read"));
    const names = ["wiki_query", "wiki_read", "wiki_read", "wiki_read", "wiki_sources", "wiki_read"];
    options.fetchImpl.mockResolvedValueOnce(completion({ role: "assistant", content: null,
      tool_calls: names.map((name, index) => ({ id: String(index), type: "function", function: { name, arguments: "{}" } })),
    }, "tool_calls")).mockResolvedValueOnce(answer());
    await runDeepSeekTurn({ ...options, executeReadBatch });
    expect(executeReadBatch).toHaveBeenCalledExactlyOnceWith([{}, {}]);
    expect(options.execute.mock.calls.map(([name]) => name)).toEqual(["wiki_query", "wiki_read", "wiki_sources", "wiki_read"]);
  });
  it("requests a final answer without tools when the overview read budget is exhausted", async () => {
    const options = setup();
    options.fetchImpl.mockImplementation(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).tools).toBeUndefined();
      return answer();
    });
    expect(await runDeepSeekTurn({ ...options, route: "database_overview", canUseTools: () => false })).toEqual(final);
  });
  it("fixes the query scope to the conversation and excludes database inventory for a subtree", async () => {
    const options = setup();
    options.fetchImpl.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name))
        .toEqual(["wiki_query", "wiki_read", "wiki_sources"]);
      expect(body.tools[0].function.parameters.properties.scope.enum).toEqual(["/Knowledge"]);
      return answer();
    });
    await runDeepSeekTurn({ ...options, scope: "/Knowledge", route: "focused_search" });
  });
  it.each([
    ["database_overview", ["wiki_inventory", "wiki_read", "wiki_sources"]],
    ["focused_search", ["wiki_query", "wiki_read", "wiki_sources"]],
    ["selected_node_summary", ["wiki_read", "wiki_sources"]],
    ["conversation", []],
  ] as const)("offers only tools permitted for %s", async (route, names) => {
    const options = setup();
    options.fetchImpl.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect((body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name)).toEqual(names);
      return answer();
    });
    await runDeepSeekTurn({ ...options, route });
  });
  it("persists submission before egress and passes read tool results into the next completion", async () => {
    const options = setup();
    const saved: unknown[] = [];
    options.checkpoint.mockImplementation(async () => { saved.push(structuredClone(options.state)); });
    options.fetchImpl.mockImplementationOnce(async (_url, init) => {
      expect(saved.at(-1)).toMatchObject({ requesting: true, rounds: 1 });
      expect(_url).toBe("https://api.deepseek.com/chat/completions");
      expect(init?.redirect).toBe("manual");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" }, response_format: { type: "json_object" } });
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
