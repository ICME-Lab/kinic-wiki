import type { Answer, QuestionSubject } from "./contracts";
import type { KinicReader, ToolState } from "./kinic";
import type { AskAiRoute } from "./routing";
import type { Conversation, Pending } from "./state";

export type TurnResult = {
  answer: Answer;
  inputTokens?: number;
  outputTokens?: number;
};

// Shared lifecycle operations; provider runners do not own leases, publication,
// voice delivery, or conversation teardown.
export type TurnContext = {
  conversation: Conversation;
  pending: Pending;
  route: AskAiRoute;
  subject: QuestionSubject;
  valid: () => Promise<boolean>;
  reader: (tools?: ToolState, route?: AskAiRoute) => Promise<KinicReader>;
  checkpoint: () => Promise<void>;
};

export type TurnFailure = {
  action: "cancel" | "retry";
  code: string;
  unknownCreate?: boolean;
};
