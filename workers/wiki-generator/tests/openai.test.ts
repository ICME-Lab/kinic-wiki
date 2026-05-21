// Where: workers/wiki-generator/tests/openai.test.ts
// What: Generated draft response parsing tests.
// Why: The model boundary must stay schema-checked before rendering or writes.
import assert from "node:assert/strict";
import test from "node:test";
import { deepSeekErrorMessage, generateDraft, parseDraftResponse, parseDraftText, validateDraftSources } from "../src/openai.js";
import type { WorkerConfig } from "../src/types.js";

const draftJson = JSON.stringify({
  title: "Project Notes",
  slug: "project-notes",
  summary: "Short summary",
  key_facts: [{ text: "Fact", source_path: "/Sources/raw/a/a.md" }],
  decisions: [],
  open_questions: [],
  follow_ups: []
});

test("DeepSeek chat completion content parses into a draft", () => {
  const draft = parseDraftResponse({ choices: [{ message: { content: draftJson } }] });
  assert.equal(draft.title, "Project Notes");
  validateDraftSources(draft, "/Sources/raw/a/a.md");
});

test("invalid draft schema is rejected", () => {
  assert.throws(() => parseDraftText('{"title":"Bad"}'), /schema/);
  const draft = parseDraftResponse({ choices: [{ message: { content: draftJson } }] });
  assert.throws(() => validateDraftSources(draft, "/Sources/raw/b/b.md"), /unsupported source/);
});

test("DeepSeek error body exposes API message", () => {
  assert.equal(deepSeekErrorMessage({ error: { message: "insufficient balance" } }), "insufficient balance");
  assert.equal(deepSeekErrorMessage({ error: "bad" }), "DeepSeek request failed");
});

test("generateDraft calls DeepSeek chat completions", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: unknown = null;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({ choices: [{ message: { content: draftJson } }] });
  };
  try {
    const draft = await generateDraft(
      {
        path: "/Sources/raw/a/a.md",
        kind: "source",
        content: "raw",
        etag: "etag-1",
        metadataJson: "{}"
      },
      [],
      config(),
      "deepseek-key"
    );

    assert.equal(requestUrl, "https://api.deepseek.com/chat/completions");
    assert.ok(isRecord(requestBody));
    assert.equal(requestBody.model, "deepseek-v4-flash");
    assert.deepEqual(requestBody.response_format, { type: "json_object" });
    assert.equal(draft.slug, "project-notes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function config(): WorkerConfig {
  return {
    canisterId: "xis3j-paaaa-aaaai-axumq-cai",
    icHost: "https://icp0.io",
    model: "deepseek-v4-flash",
    targetRoot: "/Wiki/conversations",
    sourcePrefix: "/Sources/raw",
    contextPrefix: "/Wiki",
    maxRawChars: 120_000,
    maxFetchedBytes: 1_000_000,
    maxContextHits: 8,
    maxOutputTokens: 6_000
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
