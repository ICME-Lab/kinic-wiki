import { z } from "zod";
import { answerSchema, AssistantError, validateAnswer } from "./contracts";
import { newDeepSeekTurn, runDeepSeekTurn } from "./deepseek";
import { conversationHistory } from "./conversation-history";
import { inputText } from "./turn-input";
import { seedTextContext } from "./seed-text-context";
import { prefetchSearchReads } from "./prefetch-search";
import type { TurnContext, TurnFailure, TurnResult } from "./turn-context";

// No OpenAI session, voice transport, or provider cleanup is involved here.
export async function runTextTurn(context: TurnContext, options: {
  apiKey?: string;
  deadline: number;
  signal: AbortSignal;
}): Promise<TurnResult> {
  const { conversation: c, pending: p, route, subject } = context;
  const reader = await context.reader(p.tools, route);
  const checkActive = async () => {
    if (Date.now() >= options.deadline) throw new AssistantError("turn_timeout", 502);
    if (options.signal.aborted || !(await context.valid())) throw new AssistantError("cancel_requested", 409);
  };
  const fresh = !p.deepseek;
  p.deepseek ??= newDeepSeekTurn(inputText(
    p.input.requestId, p.input.question, c.scope, p.input.selectedPath,
    conversationHistory(c, p.input.requestId), route, subject,
  ));
  p.stage = "running";
  if (fresh) {
    const started = Date.now();
    try { await seedTextContext({ route, subject, requestId: p.input.requestId,
      state: p.deepseek, reader, checkActive }); }
    finally { p.deepseek.retrievalDurationMs = (p.deepseek.retrievalDurationMs ?? 0) + Date.now() - started; }
  }
  const seededOverview = route === "database_overview" &&
    p.deepseek.messages.some((message) => message.role === "tool" && message.tool_call_id.startsWith("seed-read-"));
  const value = await runDeepSeekTurn({
    ...options,
    route,
    scope: c.scope,
    state: p.deepseek,
    validateFinal: value => { answerSchema.strip().parse(value); },
    canUseTools: () => route !== "database_overview" || (!seededOverview && p.tools.readPaths.length < 4),
    authorize: async () => {
      await checkActive();
      // Reload auth material at provider boundaries so session revocation is
      // observed before any further private context is sent to the model.
      await (await context.reader()).authorize();
      await checkActive();
    },
    checkActive,
    checkpoint: context.checkpoint,
    execute: (name, args) => reader.execute(name, args),
    executeReadBatch: (args) => reader.executeReadBatch(args),
    prefetchReads: route === "focused_search" ? messages => prefetchSearchReads(messages, reader) : undefined,
    executePrefetchBatch: args => reader.executeReadBatch(args, { skipEmpty: true }),
  });
  return {
    // Models occasionally add explanatory keys such as insufficient_note.
    // Discard unknown top-level fields; all required fields and each citation
    // remain validated against the current turn's exact evidence.
    answer: validateAnswer(answerSchema.strip().parse(value), p.tools.evidence, route !== "conversation"),
    inputTokens: p.deepseek.inputTokens,
    outputTokens: p.deepseek.outputTokens,
    providerDurationMs: p.deepseek.providerDurationMs,
    retrievalDurationMs: p.deepseek.retrievalDurationMs,
    authorizationDurationMs: p.deepseek.authorizationDurationMs,
    providerRounds: p.deepseek.rounds,
  };
}

export function textTurnFailure(error: unknown): TurnFailure {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return { action: "cancel", code: "deepseek_invalid_response" };
  // Storage/lease failures may resume a checkpoint. The DeepSeek runner rejects
  // a persisted in-flight submission rather than issuing it again.
  return { action: "retry", code: "checking_request_status" };
}
