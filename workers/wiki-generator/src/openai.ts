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

export async function generateDraft(source: WikiNode, contextHits: SearchNodeHit[], config: WorkerConfig, deepSeekApiKey: string): Promise<WikiDraft> {
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
      messages: [
        {
          role: "system",
          content: `${buildWikiDraftSystemPrompt()}\nReturn only a JSON object that matches this schema: ${JSON.stringify(wikiDraftSchema())}`
        },
        {
          role: "user",
          content: JSON.stringify({
            source_path: source.path,
            raw_content: source.content.slice(0, config.maxRawChars),
            context: contextHits.map((hit) => ({
              path: hit.path,
              preview: hit.previewExcerpt ?? hit.snippet ?? ""
            }))
          })
        }
      ]
    })
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(deepSeekErrorMessage(body));
  }
  return parseDraftResponse(body);
}

export function parseDraftResponse(body: unknown): WikiDraft {
  return parseDraftText(extractDeepSeekResponseText(body));
}

export function parseDraftText(text: string): WikiDraft {
  const parsed = JSON.parse(text);
  if (!isWikiDraft(parsed)) {
    throw new Error("generated wiki page does not match schema");
  }
  return parsed;
}

export function validateDraftSources(draft: WikiDraft, sourcePath: string): void {
  for (const section of [draft.key_facts, draft.decisions, draft.open_questions, draft.follow_ups]) {
    for (const item of section) {
      if (item.source_path !== sourcePath) {
        throw new Error(`generated item cites unsupported source: ${item.source_path}`);
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
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "slug", "summary", "key_facts", "decisions", "open_questions", "follow_ups"],
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      summary: { type: "string" },
      key_facts: { type: "array", items: item },
      decisions: { type: "array", items: item },
      open_questions: { type: "array", items: item },
      follow_ups: { type: "array", items: item }
    }
  };
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

function isWikiDraft(value: unknown): value is WikiDraft {
  if (!isObject(value)) return false;
  return (
    typeof value.title === "string" &&
    typeof value.slug === "string" &&
    typeof value.summary === "string" &&
    isDraftItemArray(value.key_facts) &&
    isDraftItemArray(value.decisions) &&
    isDraftItemArray(value.open_questions) &&
    isDraftItemArray(value.follow_ups)
  );
}

function isDraftItemArray(value: unknown): value is WikiDraftItem[] {
  return Array.isArray(value) && value.every(isDraftItem);
}

function isDraftItem(value: unknown): value is WikiDraftItem {
  return isObject(value) && typeof value.text === "string" && typeof value.source_path === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
