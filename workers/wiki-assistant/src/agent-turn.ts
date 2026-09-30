import OpenAI from "openai";
import { conversationHistory } from "./conversation-history";
import { z } from "zod";
import { AssistantError, validateAnswer } from "./contracts";
import { client, createAgent, inputText, messageText, sessionItems } from "./openai";
import type { AssistantStore } from "./store";
import type { Lease } from "./leases";
import type { TurnContext, TurnFailure, TurnResult } from "./turn-context";
import type { Conversation, Pending } from "./state";

export async function runAgentTurn(context: TurnContext, options: {
  apiKey?: string;
  principal: string;
  store: AssistantStore;
  orphanCreatedSession: (sessionId: string) => Promise<void>;
}): Promise<TurnResult | undefined> {
  const { conversation: c, pending: p } = context;
  const api = client(options.apiKey);
  // Pin the envelope before submission so polling/recovery matches the same
  // provider user item. Older in-flight turns retain their original envelope.
  const input = p.agentInput ??= inputText(
    p.input.requestId,
    p.input.question,
    c.scope,
    p.input.selectedPath,
    p.stage === "new" ? conversationHistory(c, p.input.requestId) : c.history,
    context.route,
    context.subject,
  );
  if (p.stage === "new") {
    p.stage = c.sessionId ? "sending" : "creating";
    await context.checkpoint();
    if (!c.sessionId) {
      const intent = "agent:" + c.id + ":" + p.input.requestId;
      await options.store.intent(intent, options.principal, c.id, "agent", {
        requestId: p.input.requestId,
        providerId: null,
      });
      const result = await createAgent(api, c.id, p.input.requestId, input, undefined, c.scope);
      await options.store.created(intent, result.id);
      if (!(await context.valid())) {
        await options.orphanCreatedSession(result.id);
        return;
      }
      c.sessionId = result.id;
    } else {
      await api.beta.agents.sessions.events.create(c.sessionId, {
        events: [
          {
            type: "agent.session.input.message",
            input: [
              {
                role: "user",
                content: [{ type: "input_text", text: input }],
              },
            ],
          },
        ],
      });
    }
    if (!(await context.valid())) return;
    p.stage = "running";
    await context.checkpoint();
  }
  if (!c.sessionId) {
    // Creation may have succeeded before a transport failure. Never submit it again.
    let count = 0;
    for await (const session of api.beta.agents.sessions.list({
      limit: 100,
    })) {
      if (
        session.metadata.kinic_conversation === c.id &&
        session.metadata.kinic_request === p.input.requestId
      ) {
        await options.store.created(
          "agent:" + c.id + ":" + p.input.requestId,
          session.id,
        );
        c.sessionId = session.id;
        p.stage = "running";
        await context.checkpoint();
        break;
      }
      if (++count >= 300) break;
    }
    if (!c.sessionId) return;
  }
  const sessionId = c.sessionId;
  const items = await sessionItems(api, sessionId);
  if (!(await context.valid())) return;
  const userMessage = items.find(
    (item) =>
      item.type === "message" &&
      item.role === "user" &&
      messageText(item) === input,
  );
  if (!userMessage) return; // Ambiguous input submission: reconcile, never resubmit.
  p.turnId = userMessage.turn_id;
  const session = await api.beta.agents.sessions.retrieve(sessionId);
  if (!(await context.valid())) return;
  if (session.status === "failed")
    throw new AssistantError("agent_failed", 502);
  for (const action of session.required_actions) {
    if (!(await context.valid())) return;
    if (action.type !== "function_call" || action.turn_id !== p.turnId)
      throw new AssistantError("unexpected_agent_action", 502);
    const signature = JSON.stringify({
      name: action.name,
      arguments: action.arguments,
    });
    let result = p.results[action.call_id];
    if (result && result.arguments !== signature)
      throw new AssistantError("tool_call_changed", 502);
    if (!result) {
      const reader = await context.reader(p.tools, context.route);
      const output = await reader.execute(action.name, action.arguments);
      if (!(await context.valid())) return;
      result = { arguments: signature, output };
      p.results[action.call_id] = result;
      await context.checkpoint();
    }
    await (await context.reader()).authorize();
    if (!(await context.valid())) return;
    await api.beta.agents.sessions.events.create(sessionId, {
      events: [
        {
          type: "agent.session.input.tool_result",
          turn_id: action.turn_id,
          call_id: action.call_id,
          success: true,
          output: result.output,
        },
      ],
    });
  }
  const turn = await api.beta.agents.sessions.turns.retrieve(p.turnId, {
    session_id: sessionId,
  });
  if (!(await context.valid())) return;
  if (turn.status === "failed" || turn.status === "cancelled")
    throw new AssistantError("agent_" + turn.status, 502);
  if (turn.status !== "completed") return;
  const finalItems = await sessionItems(api, sessionId);
  const final = finalItems.find(
    (item) =>
      item.type === "message" &&
      item.role === "assistant" &&
      item.turn_id === p.turnId &&
      item.phase === "final_answer",
  );
  if (!final) throw new AssistantError("answer_missing", 502);
  const answer = validateAnswer(
    JSON.parse(messageText(final)),
    p.tools.evidence,
    context.route !== "conversation",
  );
  return {
    answer,
    inputTokens: turn.usage?.input_tokens,
    outputTokens: turn.usage?.output_tokens,
  };
}

// Agents supports reconciling unknown submissions. Only this path may discard
// an uncreated provider intent or retry session polling after a transport error.
export async function agentTurnFailure(error: unknown, options: {
  conversation: Conversation;
  pending: Pending;
  store: AssistantStore;
  lease: Lease | null;
}): Promise<TurnFailure> {
  const { conversation: c, pending: p, store, lease } = options;
  if (!(error instanceof z.ZodError || error instanceof SyntaxError ||
    (error instanceof OpenAI.APIError && [400, 401, 403, 404].includes(error.status ?? 0))))
    return { action: "retry", code: "checking_request_status" };

  let unknownCreate: boolean | undefined;
  if (error instanceof OpenAI.APIError && p.stage === "creating") {
    let discarded = false;
    try {
      if (lease) discarded = await store.discardUncreatedAgentIntent(
        "agent:" + c.id + ":" + p.input.requestId, lease,
      );
    } catch {
      console.error(JSON.stringify({ event: "assistant_job_finalization_pending" }));
    }
    if (!discarded) return { action: "retry", code: "checking_request_status" };
    unknownCreate = false;
  }
  return { action: "cancel", code: "agent_response_unavailable", unknownCreate };
}
