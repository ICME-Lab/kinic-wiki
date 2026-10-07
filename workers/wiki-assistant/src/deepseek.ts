import { z } from "zod";
import { AssistantError, instructions, toolsForScope, type Scope } from "./contracts";
import type { AskAiRoute } from "./routing";
import { failureKind } from "./failure";

const callSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal("function"),
  function: z.object({ name: z.string().max(128), arguments: z.string().max(16000) }),
});
const messageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string().max(32000).nullable().optional(),
  tool_calls: z.array(callSchema).max(12).optional(),
});
type AssistantMessage = z.infer<typeof messageSchema>;
export type ChatMessage = AssistantMessage
  | { role: "system" | "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string };
export type DeepSeekTurn = {
  messages: ChatMessage[];
  requesting: boolean;
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  whitespaceRecoveries?: number;
};
const whitespaceRecoveryPrompt = "Your previous response contained only whitespace. Return a nonempty JSON object answering the original question using the Wiki evidence already provided. Required keys: answer, citations [{id,quote}], insufficient, contradictions, unverified. If evidence is insufficient, say so and set insufficient to true. Do not invent citation IDs or quotes.";
export const newDeepSeekTurn = (input: string): DeepSeekTurn => ({
  messages: [{ role: "system", content: instructions }, { role: "user", content: input }],
  requesting: false, rounds: 0, inputTokens: 0, outputTokens: 0,
});

// Checkpoint before every provider submission. An interrupted/ambiguous request
// is never automatically repeated: Chat Completions has no session reconciliation.
export async function runDeepSeekTurn(options: {
  state: DeepSeekTurn;
  apiKey?: string;
  scope: Scope;
  route?: AskAiRoute;
  deadline: number;
  authorize: () => Promise<void>;
  checkActive?: () => Promise<void>;
  checkpoint: () => Promise<void>;
  execute: (name: string, args: unknown) => Promise<string>;
  executeReadBatch?: (args: unknown[]) => Promise<string[]>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  canUseTools?: () => boolean;
}): Promise<unknown> {
  const { state, authorize, checkpoint, execute } = options;
  const checkActive = options.checkActive ?? authorize;
  if (!options.apiKey) throw new AssistantError("assistant_not_configured", 503);
  if (state.requesting) throw new AssistantError("deepseek_request_interrupted", 502);
  for (;;) {
    await checkActive();
    if (Date.now() >= options.deadline) throw new AssistantError("turn_timeout", 502);
    const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant") as AssistantMessage | undefined;
    if (lastAssistant) {
      const calls = lastAssistant.tool_calls ?? [];
      if (!calls.length) {
        if (typeof lastAssistant.content === "string" && !lastAssistant.content.trim()) {
          const repairPending = state.messages.at(-1)?.role === "user" &&
            state.messages.at(-1)?.content === whitespaceRecoveryPrompt;
          if (!repairPending) {
            if ((state.whitespaceRecoveries ?? 0) >= 1)
              throw new AssistantError("deepseek_invalid_response", 502);
            state.whitespaceRecoveries = 1;
            state.messages.push({ role: "user", content: whitespaceRecoveryPrompt });
            await checkpoint();
          }
          // Only a fully received, parsed whitespace response reaches here.
          // Persisted in-flight submissions still fail at the entry guard.
        } else {
          try { return JSON.parse(lastAssistant.content ?? ""); }
          catch { throw new AssistantError("deepseek_invalid_response", 502); }
        }
      }
      const pending = calls.filter((call) => !state.messages.some((m) => m.role === "tool" && m.tool_call_id === call.id));
      for (let index = 0; index < pending.length;) {
        const group = [pending[index++]!];
        // Preserve query/source dependencies; only adjacent body reads batch.
        if (options.executeReadBatch && group[0]!.function.name === "wiki_read" &&
            pending[index]?.function.name === "wiki_read") group.push(pending[index++]!);
        await checkActive();
        const args = group.map((call) => {
          try { return JSON.parse(call.function.arguments) as unknown; }
          catch { throw new AssistantError("deepseek_invalid_response", 502); }
        });
        const outputs = group.length > 1
          ? await options.executeReadBatch!(args)
          : [await execute(group[0]!.function.name, args[0])];
        if (outputs.length !== group.length) throw new AssistantError("deepseek_invalid_response", 502);
        await checkActive();
        for (let i = 0; i < group.length; i++)
          state.messages.push({ role: "tool", tool_call_id: group[i]!.id, content: outputs[i]! });
        await checkpoint();
      }
    }
    if (state.rounds >= 13) throw new AssistantError("tool_limit", 502);
    await authorize();
    state.requesting = true;
    state.rounds++;
    await checkpoint();
    await checkActive();
    const response = await requestCompletion(options, state.messages);
    await checkActive();
    const priorIds = new Set(state.messages.flatMap((m) => m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : []));
    for (const call of response.message.tool_calls ?? []) {
      if (priorIds.has(call.id)) throw new AssistantError("deepseek_invalid_response", 502);
      priorIds.add(call.id);
    }
    state.messages.push(response.message);
    state.inputTokens += response.inputTokens;
    state.outputTokens += response.outputTokens;
    state.requesting = false;
    await checkpoint();
  }
}

async function requestCompletion(
  options: { apiKey?: string; scope: Scope; route?: AskAiRoute; deadline: number; signal?: AbortSignal; fetchImpl?: typeof fetch; canUseTools?: () => boolean },
  messages: ChatMessage[],
) {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw new AssistantError("turn_timeout", 502);
  const timeout = AbortSignal.timeout(Math.min(45000, remaining));
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let stage = "fetch";
  try {
    const response = await (options.fetchImpl ?? fetch)("https://api.deepseek.com/chat/completions", {
      method: "POST",
      redirect: "manual",
      signal,
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-flash", thinking: { type: "disabled" },
        max_tokens: 4096, stream: false, messages, response_format: { type: "json_object" },
        ...(options.route === "conversation" || options.canUseTools?.() === false ? {} : {
          tools: toolsForScope(options.scope).filter(({ name }) =>
            name === "wiki_query" ? !options.route || options.route === "focused_search"
              : name === "wiki_inventory" ? !options.route || options.route === "database_overview"
              : true,
          ).map(({ type, ...definition }) => ({ type, function: definition })),
        }),
      }),
    });
    if (!response.ok) {
      console.error(JSON.stringify({ event: "deepseek_failure", stage, status: response.status }));
      await response.body?.cancel();
      throw new AssistantError("deepseek_unavailable", 502);
    }
    const reader = response.body?.getReader();
    stage = "read";
    if (!reader) throw new AssistantError("deepseek_invalid_response", 502);
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 256 * 1024) throw new AssistantError("deepseek_response_too_large", 502);
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    stage = "parse";
    const parsed = z.object({
      choices: z.array(z.object({
        finish_reason: z.enum(["stop", "tool_calls"]), message: messageSchema,
      })).length(1),
      usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional(),
    }).parse(JSON.parse(text));
    const choice = parsed.choices[0]!;
    if ((choice.finish_reason === "tool_calls") !== !!choice.message.tool_calls?.length)
      throw new AssistantError("deepseek_invalid_response", 502);
    return { message: choice.message, inputTokens: parsed.usage?.prompt_tokens ?? 0, outputTokens: parsed.usage?.completion_tokens ?? 0 };
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    console.error(JSON.stringify({ event: "deepseek_failure", stage, kind: failureKind(error) }));
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new AssistantError("deepseek_invalid_response", 502);
    throw new AssistantError(signal.aborted ? "deepseek_timeout" : "deepseek_request_failed", 502);
  }
}
