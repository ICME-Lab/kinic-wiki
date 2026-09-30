import { boundedRoutingHistory } from "./routing";
import type { Conversation } from "./state";

// Provider handoffs use completed dialogue as untrusted context, never as
// current-turn citation evidence. Keep the same six-message/4,000-character cap.
export function conversationHistory(c: Pick<Conversation, "history" | "messages">, currentRequestId?: string) {
  return boundedRoutingHistory([
    ...c.history,
    ...c.messages
      .filter((message) => message.requestId !== currentRequestId && message.answer !== null && message.error === null)
      .flatMap((message) => [
        { role: "user" as const, text: message.question },
        { role: "assistant" as const, text: message.answer!.answer },
      ]),
  ]);
}
