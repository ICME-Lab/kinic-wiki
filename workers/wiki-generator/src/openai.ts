// Where: workers/wiki-generator/src/openai.ts
// What: DeepSeek Chat Completions integration and draft schema validation.
// Why: The model only produces structured JSON; worker code performs all writes.
import { buildWikiDraftSystemPrompt } from "./wiki-skill.js";
import type { SearchNodeHit, WikiDraft, WikiDraftItem, WikiNode, WorkerConfig } from "./types.js";

type DeepSeekChatCompletion = {
  choices?: DeepSeekChoice[];
};

type DeepSeekChoice = {
  message?: {
    content?: string | null;
  };
};

const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";

type DraftSectionKey = "key_facts" | "decisions" | "open_questions" | "follow_ups";
type DraftLabelKey = "summary" | "key_facts" | "decisions" | "open_questions" | "follow_ups" | "related_context" | "provenance" | "none";

export class DraftValidationError extends Error {
  constructor(sourcePath: string, reason: string) {
    super(`generated knowledge page does not match schema: ${sourcePath} ${reason}`);
    this.name = "DraftValidationError";
  }
}

export async function generateDraft(source: WikiNode, contextHits: SearchNodeHit[], config: WorkerConfig, deepSeekApiKey: string): Promise<WikiDraft> {
  return parseAndValidateDraftResponse(await requestDeepSeekDraft(draftMessages(source, contextHits, config), config, deepSeekApiKey), source.path);
}

export async function requestDeepSeekDraft(
  messages: { role: "system" | "user"; content: string }[],
  config: WorkerConfig,
  deepSeekApiKey: string
): Promise<unknown> {
  const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deepSeekApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxOutputTokens,
      response_format: { type: "json_object" },
      messages
    })
  });
  if (!response.ok) {
    throw new Error(await deepSeekErrorMessageFromResponse(response));
  }
  return response.json();
}

function draftMessages(source: WikiNode, contextHits: SearchNodeHit[], config: WorkerConfig): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content: `${buildWikiDraftSystemPrompt()}\nReturn only a JSON object that matches this schema: ${JSON.stringify(wikiDraftSchema())}`
    },
    {
      role: "user",
      content: JSON.stringify(sourcePromptObject(source, contextHits, config))
    }
  ];
}

function sourcePromptObject(source: WikiNode, contextHits: SearchNodeHit[], config: WorkerConfig): object {
  return {
    source_path: source.path,
    raw_content: source.content.slice(0, config.maxRawChars),
    context: contextHits.map((hit) => ({
      path: hit.path,
      preview: hit.previewExcerpt ?? hit.snippet ?? ""
    }))
  };
}

export function parseDraftResponse(body: unknown): WikiDraft {
  return parseDraftText(extractDeepSeekResponseText(body));
}

export function parseAndValidateDraftResponse(body: unknown, sourcePath: string): WikiDraft {
  const draft = parseDraftText(extractDeepSeekResponseText(body), sourcePath);
  validateDraftSources(draft, sourcePath);
  return draft;
}

export function parseDraftText(text: string, sourcePath = "<unknown>"): WikiDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DraftValidationError(sourcePath, "response is not valid JSON");
  }
  return normalizeDraftCandidate(parsed, sourcePath);
}

export function validateDraftSources(draft: WikiDraft, sourcePath: string): void {
  for (const section of [draft.key_facts, draft.decisions, draft.open_questions, draft.follow_ups]) {
    for (const [index, item] of section.entries()) {
      if (item.source_path !== sourcePath) {
        throw new DraftValidationError(sourcePath, `item source_path mismatch at index ${index}: ${item.source_path}`);
      }
    }
  }
}

function wikiDraftSchema(): object {
  const item = {
    type: "object",
    additionalProperties: false,
    required: ["text", "source_path"],
    properties: {
      text: { type: "string" },
      source_path: { type: "string" }
    }
  };
  const label = { type: "string", minLength: 1, pattern: "^(?!\\s*$)[^\\r\\n]+$" };
  const labels = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "key_facts", "decisions", "open_questions", "follow_ups", "related_context", "provenance", "none"],
    properties: {
      summary: label,
      key_facts: label,
      decisions: label,
      open_questions: label,
      follow_ups: label,
      related_context: label,
      provenance: label,
      none: label
    }
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "slug", "labels", "summary", "key_facts", "decisions", "open_questions", "follow_ups"],
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      labels,
      summary: { type: "string" },
      key_facts: { type: "array", items: item },
      decisions: { type: "array", items: item },
      open_questions: { type: "array", items: item },
      follow_ups: { type: "array", items: item }
    }
  };
}

async function deepSeekErrorMessageFromResponse(response: Response): Promise<string> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    return `DeepSeek request failed: ${response.status} ${response.statusText || "non-JSON response"}`.trim();
  }
  return deepSeekErrorMessage(body);
}

export function deepSeekErrorMessage(body: unknown): string {
  if (isObject(body)) {
    const error = body.error;
    if (isObject(error) && typeof error.message === "string") {
      return error.message;
    }
  }
  return "DeepSeek request failed";
}

function extractDeepSeekResponseText(body: unknown): string {
  if (!isDeepSeekChatCompletion(body)) {
    throw new Error("DeepSeek response shape is invalid");
  }
  for (const choice of body.choices ?? []) {
    const content = choice.message?.content;
    if (typeof content === "string" && content) {
      return content;
    }
  }
  throw new Error("DeepSeek response did not include text");
}

function isDeepSeekChatCompletion(value: unknown): value is DeepSeekChatCompletion {
  if (!isObject(value)) return false;
  if (!("choices" in value) || value.choices === undefined) return true;
  return Array.isArray(value.choices) && value.choices.every(isDeepSeekChoice);
}

function isDeepSeekChoice(value: unknown): value is DeepSeekChoice {
  if (!isObject(value)) return false;
  if (!("message" in value) || value.message === undefined) return true;
  if (!isObject(value.message)) return false;
  const content = value.message.content;
  return content === undefined || content === null || typeof content === "string";
}

function normalizeDraftCandidate(value: unknown, sourcePath: string): WikiDraft {
  if (!isObject(value)) throw new DraftValidationError(sourcePath, "top-level value must be an object");
  const title = requiredString(value, "title", "title", sourcePath);
  const slug = requiredString(value, "slug", "slug", sourcePath);
  const summary = requiredString(value, "summary", "summary", sourcePath);
  const labels = normalizeDraftLabels(value.labels, sourcePath);
  return {
    title,
    slug,
    labels,
    summary,
    key_facts: normalizeDraftSection(value.key_facts, "key_facts", sourcePath),
    decisions: normalizeDraftSection(value.decisions, "decisions", sourcePath),
    open_questions: normalizeDraftSection(value.open_questions, "open_questions", sourcePath),
    follow_ups: normalizeDraftSection(value.follow_ups, "follow_ups", sourcePath)
  };
}

function normalizeDraftLabels(value: unknown, sourcePath: string): WikiDraft["labels"] {
  if (!isObject(value)) throw new DraftValidationError(sourcePath, "labels must be an object");
  return {
    summary: requiredLabel(value, "summary", sourcePath),
    key_facts: requiredLabel(value, "key_facts", sourcePath),
    decisions: requiredLabel(value, "decisions", sourcePath),
    open_questions: requiredLabel(value, "open_questions", sourcePath),
    follow_ups: requiredLabel(value, "follow_ups", sourcePath),
    related_context: requiredLabel(value, "related_context", sourcePath),
    provenance: requiredLabel(value, "provenance", sourcePath),
    none: requiredLabel(value, "none", sourcePath)
  };
}

function normalizeDraftSection(value: unknown, key: DraftSectionKey, sourcePath: string): WikiDraftItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DraftValidationError(sourcePath, `${key} must be an array`);
  return value.map((item, index) => normalizeDraftItem(item, `${key}[${index}]`, sourcePath));
}

function normalizeDraftItem(value: unknown, path: string, sourcePath: string): WikiDraftItem {
  if (!isObject(value)) throw new DraftValidationError(sourcePath, `${path} must be an object`);
  return {
    text: requiredString(value, "text", `${path}.text`, sourcePath),
    source_path: requiredString(value, "source_path", `${path}.source_path`, sourcePath)
  };
}

function requiredString(value: Record<string, unknown>, key: string, label: string, sourcePath: string): string {
  const raw = value[key];
  if (typeof raw !== "string") throw new DraftValidationError(sourcePath, `${label} must be a string`);
  return raw;
}

function requiredLabel(value: Record<string, unknown>, key: DraftLabelKey, sourcePath: string): string {
  const label = requiredString(value, key, `labels.${key}`, sourcePath);
  if (label.trim().length === 0) throw new DraftValidationError(sourcePath, `labels.${key} must be non-empty`);
  if (/[\r\n]/.test(label)) throw new DraftValidationError(sourcePath, `labels.${key} must be a single line`);
  return label;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
