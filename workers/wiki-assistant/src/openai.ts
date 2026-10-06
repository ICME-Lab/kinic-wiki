import OpenAI from "openai";
import type { AgentSessionItem } from "openai/resources/beta/agents/agents";
import { instructions, toolsForScope, AssistantError, type Scope } from "./contracts";

export function client(apiKey?: string): OpenAI {
  if (!apiKey) throw new AssistantError("assistant_not_configured", 503);
  return new OpenAI({ apiKey, maxRetries: 0, timeout: 15000 });
}
export { inputText } from "./turn-input";
export async function createAgent(
  api: OpenAI,
  conversationId: string,
  requestId: string,
  input: string,
  signal?: AbortSignal,
  scope: Scope = "database",
) {
  return api.beta.agents.sessions.create({
    environment: { type: "none" },
    agent: {
      model: "gpt-5.6-luna",
      instructions,
      tools: toolsForScope(scope),
      multi_agent: { enabled: false },
      reasoning: { effort: "low" },
    },
    metadata: { kinic_conversation: conversationId, kinic_request: requestId },
    input,
  }, { signal });
}
export function messageText(item: AgentSessionItem): string {
  return item.type === "message"
    ? item.content.map((part) => ("text" in part ? part.text : "")).join("")
    : "";
}
export async function sessionItems(
  api: OpenAI,
  id: string,
  signal?: AbortSignal,
): Promise<AgentSessionItem[]> {
  // Bounded recent history: a conversation has at most the daily request limit.
  const items: AgentSessionItem[] = [];
  for await (const item of api.beta.agents.sessions.items.list(id, {
    order: "desc",
    limit: 100,
  }, { signal })) {
    items.push(item);
    if (items.length >= 300) break;
  }
  return items;
}
export async function cancelAgent(api: OpenAI, id: string, signal?: AbortSignal): Promise<void> {
  await api.beta.agents.sessions.events.create(id, {
    events: [{ type: "agent.session.input.cancel" }],
  }, { signal });
}
export async function deleteAgent(api: OpenAI, id: string, signal?: AbortSignal): Promise<void> {
  try {
    await api.beta.agents.sessions.delete(id, { signal });
  } catch (error) {
    if (!(error instanceof OpenAI.APIError && error.status === 404))
      throw error;
  }
}
