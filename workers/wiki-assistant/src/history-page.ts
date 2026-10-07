import { AssistantError } from "./contracts";
import type { Conversation } from "./state";

export type HistoryEntry =
  | { kind: "message"; value: Conversation["messages"][number] }
  | { kind: "utterance"; value: Pick<Conversation["utterances"][number], "id" | "role" | "text"> };

export function boundedHistoryPage(revision: number, cursor: number, total: number, entries: HistoryEntry[]) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > total)
    throw new AssistantError("invalid_cursor", 400);
  const messages: Conversation["messages"] = [];
  const utterances: Extract<HistoryEntry, { kind: "utterance" }>["value"][] = [];
  let consumed = 0;
  for (const entry of entries.slice(0, 10)) {
    // Build the candidate before accepting it so even one oversized item fails.
    const payload = {
      revision,
      messages: entry.kind === "message" ? [...messages, entry.value] : messages,
      utterances: entry.kind === "utterance" ? [...utterances, entry.value] : utterances,
      nextCursor: cursor + consumed + 1 < total ? String(cursor + consumed + 1) : null,
    };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 512_000) {
      if (!consumed) throw new AssistantError("history_item_too_large", 500);
      break;
    }
    if (entry.kind === "message") messages.push(entry.value);
    else utterances.push(entry.value);
    consumed++;
  }
  return { revision, messages, utterances, nextCursor: cursor + consumed < total ? String(cursor + consumed) : null };
}
