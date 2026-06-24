// Where: workers/wiki-generator/tests/openai.test.ts
// What: LLM response parsing tests.
// Why: The model boundary must stay schema-checked before rendering or writes.
import assert from "node:assert/strict";
import test from "node:test";
import { deepSeekErrorMessage, generateDraft, parseDraftResponse, parseDraftText, validateDraftSources } from "../src/openai.js";
import type { WorkerConfig } from "../src/types.js";

const draftJson = JSON.stringify({
  title: "Project Notes",
  slug: "project-notes",
  labels: {
    summary: "Summary",
    key_facts: "Key Facts",
    decisions: "Decisions",
    open_questions: "Open Questions",
    follow_ups: "Follow-ups",
    related_context: "Related Context",
    provenance: "Provenance",
    none: "none"
  },
  summary: "Short summary",
  key_facts: [{ text: "Fact", source_path: "/Sources/a/a.md" }],
  decisions: [],
  open_questions: [],
  follow_ups: []
});

test("DeepSeek chat completion content parses into a draft", () => {
  const draft = parseDraftResponse({ choices: [{ message: { content: draftJson } }] });
  assert.equal(draft.title, "Project Notes");
  validateDraftSources(draft, "/Sources/a/a.md");
});

test("invalid draft schema is rejected", () => {
  assert.throws(() => parseDraftText('{"title":"Bad"}'), /schema/);
  const draft = parseDraftResponse({ choices: [{ message: { content: draftJson } }] });
  assert.throws(() => validateDraftSources(draft, "/Sources/b/b.md"), /unsupported source/);
  assert.throws(() => parseDraftText(JSON.stringify({ ...JSON.parse(draftJson), extra: true })), /schema/);
  assert.throws(
    () => parseDraftText(JSON.stringify({ ...JSON.parse(draftJson), labels: { ...JSON.parse(draftJson).labels, extra: true } })),
    /schema/
  );
  assert.throws(
    () => parseDraftText(JSON.stringify({ ...JSON.parse(draftJson), key_facts: [{ text: "Fact", source_path: "/Sources/a/a.md", extra: true }] })),
    /schema/
  );
});

test("draft labels must be non-empty single-line strings", () => {
  assert.throws(
    () => parseDraftText(JSON.stringify({ ...JSON.parse(draftJson), labels: { ...JSON.parse(draftJson).labels, summary: "" } })),
    /schema/
  );
  assert.throws(
    () => parseDraftText(JSON.stringify({ ...JSON.parse(draftJson), labels: { ...JSON.parse(draftJson).labels, summary: "Summary\nInjected" } })),
    /schema/
  );
  const multilingual = parseDraftText(JSON.stringify({ ...JSON.parse(draftJson), labels: { ...JSON.parse(draftJson).labels, summary: "概要" } }));
  assert.equal(multilingual.labels.summary, "概要");
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
        path: "/Sources/a/a.md",
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
    assert.match(JSON.stringify(requestBody.messages), /pattern/);
    assert.match(JSON.stringify(requestBody.messages), /non-empty single-line strings/);
    assert.equal(draft.slug, "project-notes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateDraft reports non-JSON DeepSeek failures before parsing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => new Response("insufficient balance", { status: 402, statusText: "Payment Required" });
  try {
    await assert.rejects(
      generateDraft(
        {
          path: "/Sources/a/a.md",
          kind: "source",
          content: "raw",
          etag: "etag-1",
          metadataJson: "{}"
        },
        [],
        config(),
        "deepseek-key"
      ),
      /DeepSeek request failed: 402 Payment Required/
    );
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
    sourcePrefix: "/Sources",
    contextPrefix: "/Wiki",
    maxRawChars: 120_000,
    maxFetchedBytes: 5_000_000,
    maxSourceChars: 300_000,
    maxContextHits: 8,
    maxOutputTokens: 6_000
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
