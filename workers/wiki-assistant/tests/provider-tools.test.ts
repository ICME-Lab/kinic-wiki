import OpenAI from "openai";
import { expect, it, vi } from "vitest";
import { createAgent } from "../src/openai";

it.each(["/Knowledge", "/Memory", "database"] as const)("binds Agent search tools to %s without changing other sessions", async (scope) => {
  const create = vi.fn().mockResolvedValue({ id: "session" });
  const api = { beta: { agents: { sessions: { create } } } } as unknown as OpenAI;
  await createAgent(api, "conversation", "request", "input", undefined, scope);
  const tools = create.mock.calls[0][0].agent.tools;
  expect(tools.find((tool: { name: string }) => tool.name === "wiki_query").parameters.properties.scope.enum).toEqual([scope]);
  expect(tools.some((tool: { name: string }) => tool.name === "wiki_inventory")).toBe(scope === "database");
  await createAgent(api, "another-conversation", "another-request", "input", undefined, "database");
  expect(create.mock.calls[1][0].agent.tools[0].parameters.properties.scope.enum).toEqual(["database"]);
  expect(tools[0].parameters.properties.scope.enum).toEqual([scope]);
});
