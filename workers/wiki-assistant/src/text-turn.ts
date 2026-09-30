import { z } from "zod";
import { AssistantError, validateAnswer } from "./contracts";
import { newDeepSeekTurn, runDeepSeekTurn } from "./deepseek";
import { conversationHistory } from "./conversation-history";
import { inputText } from "./turn-input";
import type { TurnContext, TurnFailure, TurnResult } from "./turn-context";

// No OpenAI session, voice transport, or provider cleanup is involved here.
export async function runTextTurn(context: TurnContext, options: {
  apiKey?: string;
  deadline: number;
  signal: AbortSignal;
}): Promise<TurnResult> {
  const { conversation: c, pending: p, route, subject } = context;
  p.deepseek ??= newDeepSeekTurn(inputText(
    p.input.requestId, p.input.question, c.scope, p.input.selectedPath,
    conversationHistory(c, p.input.requestId), route, subject,
  ));
  p.stage = "running";
  const value = await runDeepSeekTurn({
    ...options,
    route,
    scope: c.scope,
    state: p.deepseek,
    authorize: async () => {
      if (!(await context.valid())) throw new AssistantError("cancel_requested", 409);
      await (await context.reader()).authorize();
      if (!(await context.valid())) throw new AssistantError("cancel_requested", 409);
    },
    checkpoint: context.checkpoint,
    execute: async (name, args) => (await context.reader(p.tools, route)).execute(name, args),
  });
  return {
    answer: validateAnswer(value, p.tools.evidence, route !== "conversation"),
    inputTokens: p.deepseek.inputTokens,
    outputTokens: p.deepseek.outputTokens,
  };
}

export function textTurnFailure(error: unknown): TurnFailure {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return { action: "cancel", code: "deepseek_invalid_response" };
  // Storage/lease failures may resume a checkpoint. The DeepSeek runner rejects
  // a persisted in-flight submission rather than issuing it again.
  return { action: "retry", code: "checking_request_status" };
}
