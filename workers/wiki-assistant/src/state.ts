import type { z } from "zod";
import type { questionSchema, Answer, Scope } from "./contracts";
import type { ToolState } from "./kinic";
import type { AskAiRoute } from "./routing";
import type { DeepSeekTurn } from "./deepseek";

// Persisted format stays unchanged when execution paths are reorganized.
export type Question = z.infer<typeof questionSchema>;
export type Pending = {
  input: Question;
  deepseek?: DeepSeekTurn;
  agentInput?: string;
  generation: number;
  started: number;
  stage: "new" | "creating" | "sending" | "running";
  turnId: string | null;
  tools: ToolState;
  results: Record<string, { arguments: string; output: string }>;
  delegationId: string | null;
  route: "pending" | AskAiRoute;
};
export type Transcript = {
  role: "user" | "assistant";
  text: string;
  start: number;
  end: number;
};
export type Charge = {
  attempts?: number;
  nextAttempt?: number;
  id: string;
  conversationId: string;
  databaseId: string;
  principal: string;
  rate: string;
  reserved: number;
  started: number | null;
  stopped: number | null;
  expires: number;
  confirmed: number;
};
export type VoiceUsage = {
  chargeId?: string;
  started: number;
  reserved: number;
  usageDay: string;
  settled: boolean;
};
export type Conversation = {
  format: 3;
  native?: boolean;
  nativeTextProvider?: "deepseek";
  selectedPath?: string;
  history: { role: "user" | "assistant"; text: string }[];
  utterances: { id: string; voiceId: string; events: string[]; end: number; role: "user" | "assistant"; text: string }[];
  id: string;
  authId: string;
  principal: string;
  databaseId: string;
  scope: Scope;
  sessionId: string | null;
  generation: number;
  pending: Pending | null;
  activity: number;
  seen: number;
  status: "ready" | "working" | "cancelling";
  error: string | null;
  messages: {
    voice: boolean;
    requestId: string;
    question: string;
    answer: Answer | null;
    error: string | null;
    kind: "grounded_answer" | "conversation" | "clarification" | null;
    trace: {
      route: AskAiRoute | "clarification";
      calls: number;
      characters: number;
      inventoryObserved: number;
      inventoryTruncated: boolean;
      readCount: number;
      jevRouteDurationMs: number;
      jevRerankDurationMs: number;
    } | null;
  }[];
  live: {
    id: string | null;
    usage: VoiceUsage;
    stopping: boolean;
  } | null;
  transcripts: Transcript[];
  delegations: string[];
  deferred: { id: string; offset: number } | null;
};
export type Cleanup = {
  attempts?: number;
  nextAttempt?: number;
  sessionId: string | null;
  conversationId: string;
  unknownCreate: boolean;
  liveId: string | null;
  requestId?: string;
  voiceUsage?: VoiceUsage;
};
export type UserState = {
  endRequested?: number;
  charges: Charge[];
  principal: string | null;
  day: string;
  questions: number;
  voiceSeconds: number;
  conversation: Conversation | null;
  cleanup: Cleanup[];
};
