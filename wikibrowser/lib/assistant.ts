import type { Answer, Scope } from "../../workers/wiki-assistant/src/contracts";
export type {
  Answer,
  Citation,
  Scope,
} from "../../workers/wiki-assistant/src/contracts";
export type AssistantState = {
  revision: number;
  id: string;
  databaseId: string;
  scope: Scope;
  status: "ready" | "working" | "cancelling";
  error: string | null;
  generation: number;
  reconnectGraceMs: number;
  voiceId?: string | null;
  voiceDeadline?: number | null;
  voice: "off" | "connected" | "stopping";
  progress: { calls: number; stage: string } | null;
};
export type AssistantMessage = {
  requestId: string;
  question: string;
  answer: Answer | null;
  error: string | null;
};
export type AssistantUtterance = {
  id: string;
  role: "user" | "assistant";
  text: string;
};
export type AssistantSnapshot = AssistantState & {
  utterances: AssistantUtterance[];
  messages: AssistantMessage[];
};
export type AssistantHistoryPage = {
  revision: number;
  messages: AssistantMessage[];
  utterances: AssistantUtterance[];
  nextCursor: string | null;
};
export type AssistantCommandResult = { revision: number };
export const CONSENT_VERSION = "2026-09-22";
const errors: Record<string, string> = {
  assistant_disabled: "Ask AI is not available yet.",
  assistant_not_configured: "Ask AI has not been configured yet.",
  authentication_required: "Connect with Internet Identity to use Ask AI.",
  choose_questions_only: "Select “Questions only” in Internet Identity.",
  identity_changed:
    "Your Wiki and Ask AI accounts do not match. Connect with the same account.",
  reconnect_expired:
    "The reconnect window has expired. Start a new conversation.",
  conversation_ended: "The conversation has ended.",
  conversation_already_active:
    "A conversation is already open. End it in the original tab or wait two minutes after disconnecting.",
  conversation_not_owned: "You do not have access to this conversation.",
  cleanup_pending:
    "Confirming deletion of the previous conversation. Please wait.",
  turn_in_progress: "A question is being processed. Please wait or cancel it.",
  question_limit: "You have reached your daily question limit.",
  turn_timeout: "The request timed out. Try a more specific question.",
  wiki_read_denied: "Unable to verify read access to this Wiki.",
  invalid_citation:
    "The sources could not be verified, so the answer cannot be displayed.",
  unsupported_answer: "No verified sources support this answer.",
  jev_unavailable:
    "Semantic routing is temporarily unavailable. Try the question again.",
  checking_request_status:
    "The connection was interrupted. Checking the request status.",
  cancel_requested: "Cancellation requested.",
};
export function assistantError(code: string): string {
  return (
    errors[code] ??
    "Ask AI could not complete the request. Check your connection and settings."
  );
}
export class AssistantRequestError extends Error {
  constructor(readonly code: string) {
    super(assistantError(code));
  }
}
export function assistantUrl(
  path: string,
  conversationId?: string,
  query: Record<string, string> = {},
): string {
  const parameters = new URLSearchParams(query);
  if (conversationId) parameters.set("conversationId", conversationId);
  const suffix = parameters.size ? `?${parameters}` : "";
  return `/api/assistant${path}${suffix}`;
}
export async function assistantRequest<T>(
  path: string,
  options: {
    body?: unknown;
    conversationId?: string;
    query?: Record<string, string>;
    signal?: AbortSignal;
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const response = await fetch(
    assistantUrl(path, options.conversationId, options.query),
    {
      method: options.body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      signal: options.signal,
      keepalive: options.keepalive,
      headers:
        options.body === undefined
          ? undefined
          : { "content-type": "application/json" },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    },
  );
  const value = await response.json().catch(() => {
    throw new AssistantRequestError("request_failed");
  });
  if (!response.ok)
    throw new AssistantRequestError(
      typeof value?.error === "string" ? value.error : "request_failed",
    );
  return value as T;
}

export async function assistantSnapshot(
  conversationId: string,
  initialState?: AssistantState,
  signal?: AbortSignal,
): Promise<AssistantSnapshot> {
  let initial = initialState;
  for (let attempt = 0; attempt < 3; attempt++) {
    const state =
      initial ??
      (await assistantRequest<AssistantState>("/conversation", {
        conversationId,
        signal,
      }));
    initial = undefined;
    if (state.id !== conversationId)
      throw new AssistantRequestError("request_failed");
    const messages: AssistantMessage[] = [];
    const utterances: AssistantUtterance[] = [];
    let cursor: string | null = "0";
    try {
      while (cursor !== null) {
        const page: AssistantHistoryPage =
          await assistantRequest<AssistantHistoryPage>("/history", {
            conversationId,
            query: { revision: String(state.revision), cursor },
            signal,
          });
        if (page.revision !== state.revision)
          throw new AssistantRequestError("stale_state");
        messages.push(...page.messages);
        utterances.push(...page.utterances);
        cursor = page.nextCursor;
      }
      return { ...state, messages, utterances };
    } catch (error) {
      if (
        error instanceof AssistantRequestError &&
        error.code === "stale_state"
      )
        continue;
      throw error;
    }
  }
  throw new AssistantRequestError("stale_state");
}

export class AssistantControl {
  private socket: WebSocket | null = null;
  private generation = 0;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  attach(socket: WebSocket) {
    this.detach();
    this.generation = 0;
    this.socket = socket;
  }
  detach() {
    this.socket = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AssistantRequestError("connection_lost"));
    }
    this.pending.clear();
  }
  receive(value: {
    type?: string;
    generation?: number;
    requestId?: string;
    status?: number;
    body?: unknown;
  }) {
    if (value.type === "snapshot" && typeof value.generation === "number")
      this.generation = Math.max(this.generation, value.generation);
    if (value.type !== "command.result" || !value.requestId) return false;
    const p = this.pending.get(value.requestId);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(value.requestId);
      if ((value.status ?? 500) < 300) p.resolve(value.body);
      else
        p.reject(
          new AssistantRequestError(
            (value.body as { error?: string })?.error ?? "request_failed",
          ),
        );
    }
    return true;
  }
  command<T>(
    action: string,
    payload: Record<string, unknown>,
    requestId: string = crypto.randomUUID(),
  ): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new AssistantRequestError("connection_lost"));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AssistantRequestError("command_outcome_pending"));
      }, 95000);
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.socket!.send(
          JSON.stringify({
            type: "command",
            action,
            payload,
            requestId,
            generation: this.generation,
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
}
