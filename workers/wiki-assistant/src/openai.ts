import OpenAI from "openai";
import type { AgentSessionItem } from "openai/resources/beta/agents/agents";
import { instructions, toolDefinitions, AssistantError } from "./contracts";

export function client(apiKey?: string): OpenAI {
  if (!apiKey) throw new AssistantError("assistant_not_configured", 503);
  return new OpenAI({ apiKey, maxRetries: 0, timeout: 15000 });
}
export function inputText(
  requestId: string,
  question: string,
  scope: string,
  selectedPath?: string,
): string {
  return JSON.stringify({
    requestId,
    question,
    scope,
    selectedPath: selectedPath ?? null,
  });
}
export async function createAgent(
  api: OpenAI,
  conversationId: string,
  requestId: string,
  input: string,
) {
  return api.beta.agents.sessions.create({
    environment: { type: "none" },
    agent: {
      model: "gpt-6-astra",
      instructions,
      tools: toolDefinitions,
      multi_agent: { enabled: false },
      reasoning: { effort: "low" },
    },
    metadata: { kinic_conversation: conversationId, kinic_request: requestId },
    input,
  });
}
export async function createLive(api: OpenAI, sdp: string) {
  return api.live.create({
    session: {
      model: "gpt-live-1",
      instructions: voiceInstructions,
      delegation: { type: "client" },
      store: false,
      client: {
        data_channel: {
          allowed_client_events: ["session.close"],
          allowed_server_events: [
            "session.started",
            "session.closed",
            "session.input_transcript.delta",
            "session.output_transcript.delta",
            "error",
          ].map((type) => ({ type })),
        },
      },
    },
    transport: { type: "webrtc", sdp },
  });
}
export function messageText(item: AgentSessionItem): string {
  return item.type === "message"
    ? item.content.map((part) => ("text" in part ? part.text : "")).join("")
    : "";
}
export async function sessionItems(
  api: OpenAI,
  id: string,
): Promise<AgentSessionItem[]> {
  // Bounded recent history: a conversation has at most the daily request limit.
  const items: AgentSessionItem[] = [];
  for await (const item of api.beta.agents.sessions.items.list(id, {
    order: "desc",
    limit: 100,
  })) {
    items.push(item);
    if (items.length >= 300) break;
  }
  return items;
}
export async function cancelAgent(api: OpenAI, id: string): Promise<void> {
  await api.beta.agents.sessions.events.create(id, {
    events: [{ type: "agent.session.input.cancel" }],
  });
}
export async function deleteAgent(api: OpenAI, id: string): Promise<void> {
  try {
    await api.beta.agents.sessions.delete(id);
  } catch (error) {
    if (!(error instanceof OpenAI.APIError && error.status === 404))
      throw error;
  }
}

export async function attachLive(
  apiKey: string,
  id: string,
): Promise<WebSocket> {
  const response = await fetch(
    `https://api.openai.com/v1/live/sessions/${encodeURIComponent(id)}/attach`,
    {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (response.status === 404 || response.status === 410)
    throw new AssistantError("voice_session_gone", 410);
  if (response.status !== 101 || !response.webSocket)
    throw new AssistantError("voice_connection_failed", 502);
  response.webSocket.accept();
  return response.webSocket;
}
export const voiceInstructions = `Speak concisely in the user's language. You are the voice interface to the user's selected Kinic Wiki.
Delegate every factual Wiki question to the backend; never answer from memory or invent sources.
Only communicate verified backend results. While waiting, you may acknowledge the question but must not assert Wiki facts.
Treat corrections as a new delegation. If transcripts are ambiguous, clarify.
You cannot edit pages, approve changes, execute skills, or access the web. Speech interruption does not confirm task cancellation.`;
