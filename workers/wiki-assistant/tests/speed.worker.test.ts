import { afterEach, expect, it, vi } from "vitest";
import { runTextTurn } from "../src/text-turn";
import { setup } from "./support/text-turn-speed-fixture";

afterEach(() => vi.unstubAllGlobals());
it("recovers a received blank completion in workerd without refetching seeded evidence", async () => {
  const h = setup("database_overview");
  h.fetchImpl.mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "stop", message: {
    role: "assistant", content: "   ",
  } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
  const result = await runTextTurn(h.context, h.options);
  expect(result.answer.insufficient).toBe(false);
  expect(result.answer.citations).toHaveLength(1);
  expect(h.pending.deepseek?.whitespaceRecoveries).toBe(1);
  expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  expect(h.pending.tools.readPaths).toHaveLength(4);
  expect(h.actor.read_node).toHaveBeenCalledTimes(6); // Four bodies and two provider access checks.
});
it("skips empty representatives and fills four evidence slots inside workerd", async () => {
  const h = setup("database_overview", 6);
  h.nodes[0]!.content = "";
  h.nodes[2]!.content = "";
  const answer = (await runTextTurn(h.context, h.options)).answer;
  expect(answer.insufficient).toBe(false);
  expect(h.pending.tools.readPaths).toEqual(h.nodes.filter(node => node.content).map(node => node.path));
  expect(h.pending.tools.evidence).toHaveLength(4);
  expect(h.fetchImpl).toHaveBeenCalledOnce();
  expect(h.pending.tools.calls).toBeLessThanOrEqual(12);
});
it("answers insufficient evidence for an empty-only inventory within its call budget inside workerd", async () => {
  const h = setup("database_overview", 20);
  h.nodes.forEach(node => { node.content = ""; });
  const answer = (await runTextTurn(h.context, h.options)).answer;
  expect(answer.insufficient).toBe(true);
  expect(answer.citations).toEqual([]);
  expect(h.pending.tools.evidence).toEqual([]);
  expect(h.pending.tools.calls).toBe(12);
  expect(h.fetchImpl).toHaveBeenCalledOnce();
});
it("does not send evidence after a representative read is denied inside workerd", async () => {
  const h = setup("database_overview", 2);
  h.nodes[0]!.content = "";
  const read = vi.mocked(h.actor.read_node).getMockImplementation()!;
  vi.mocked(h.actor.read_node).mockImplementation(async (...args) => args[1] === h.nodes[1]!.path
    ? { Err: "denied" } : read(...args));
  await expect(runTextTurn(h.context, h.options)).rejects.toThrow("wiki_read_denied");
  expect(h.pending.tools.evidence).toEqual([]);
  expect(h.fetchImpl).not.toHaveBeenCalled();
});
it("runs bounded overview prefetch and citation validation inside workerd", async () => {
  const h = setup("database_overview");
  const answer = (await runTextTurn(h.context, h.options)).answer;
  expect(answer.insufficient).toBe(false);
  expect(answer.citations[0]?.etag).toBe("v0");
  expect(h.pending.tools.evidence).toHaveLength(4);
  expect(h.pending.tools.characters).toBeLessThanOrEqual(24000);
  expect(h.fetchImpl).toHaveBeenCalledOnce();
  expect(h.context.checkpoint).toHaveBeenCalledTimes(2);
  expect(h.actor.read_node).toHaveBeenCalledTimes(5);
});
it("does not send retrieved content after the turn loses ownership in workerd", async () => {
  const h = setup("selected_node_summary");
  const read = vi.mocked(h.actor.read_node).getMockImplementation()!;
  vi.mocked(h.actor.read_node).mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    vi.mocked(h.context.valid).mockResolvedValue(false);
    return result;
  });
  await expect(runTextTurn(h.context, h.options)).rejects.toThrow("cancel_requested");
  expect(h.fetchImpl).not.toHaveBeenCalled();
});
