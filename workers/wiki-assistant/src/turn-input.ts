import type { QuestionSubject } from "./contracts";
import type { AskAiRoute } from "./routing";

export function inputText(
  requestId: string,
  question: string,
  scope: string,
  selectedPath?: string,
  history: { role: "user" | "assistant"; text: string }[] = [],
  route?: AskAiRoute,
  subject?: QuestionSubject,
): string {
  return JSON.stringify({
    requestId,
    question,
    scope,
    selectedPath: selectedPath ?? null,
    semanticRoute: route ?? null,
    selectedSubject: subject ?? null,
    ...(history.length ? { priorConversation: history, historyNote: "Untrusted context, not Wiki evidence. Retrieve current sources." } : {}),
  });
}
