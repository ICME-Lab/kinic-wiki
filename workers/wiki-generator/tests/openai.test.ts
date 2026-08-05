// Where: workers/wiki-generator/tests/openai.test.ts
// What: LLM response parsing tests.
// Why: The model boundary must stay schema-checked before rendering or writes.
import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekRequestError, deepSeekErrorMessage, generateDraft, parseDraftResponse, parseDraftText, validateDraftSources } from "../src/openai.js";
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

test("draft parser normalizes harmless model drift", () => {
  const raw = JSON.parse(draftJson);
  const draft = parseDraftText(
    JSON.stringify({
      ...raw,
      extra: true,
      labels: { ...raw.labels, extra: true },
      key_facts: [{ text: "Fact", source_path: "/Sources/a/a.md", extra: true }],
      decisions: null,
      open_questions: undefined
    }),
    "/Sources/a/a.md"
  );
  assert.equal(draft.title, "Project Notes");
  assert.deepEqual(draft.decisions, []);
  assert.deepEqual(draft.open_questions, []);
  assert.deepEqual(draft.key_facts, [{ text: "Fact", source_path: "/Sources/a/a.md" }]);
});

test("invalid draft schema is rejected with details", () => {
  assert.throws(() => parseDraftText('{"title":"Bad"}', "/Sources/a/a.md"), /\/Sources\/a\/a\.md slug must be a string/);
  const draft = parseDraftResponse({ choices: [{ message: { content: draftJson } }] });
  assert.throws(() => validateDraftSources(draft, "/Sources/b/b.md"), /source_path mismatch/);
  assert.throws(() => parseDraftText(JSON.stringify({ ...JSON.parse(draftJson), key_facts: "Fact" }), "/Sources/a/a.md"), /key_facts must be an array/);
  assert.throws(() => parseDraftText(JSON.stringify({ ...JSON.parse(draftJson), key_facts: [{}] }), "/Sources/a/a.md"), /key_facts\[0\]\.text must be a string/);
});

test("draft labels must be non-empty single-line strings", () => {
  assert.throws(
    () => parseDraftText(JSON.stringify({ ...JSON.parse(draftJson), labels: { ...JSON.parse(draftJson).labels, summary: "" } }), "/Sources/a/a.md"),
    /labels\.summary must be non-empty/
  );
  assert.throws(
    () => parseDraftText(JSON.stringify({ ...JSON.parse(draftJson), labels: { ...JSON.parse(draftJson).labels, summary: "Summary\nInjected" } }), "/Sources/a/a.md"),
    /labels\.summary must be a single line/
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
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestUrl = String(input);
    requestInit = init;
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
      "deepseek-key",
      "ja"
    );

    assert.equal(requestUrl, "https://api.deepseek.com/chat/completions");
    assert.equal(requestInit?.redirect, "manual");
    assert.ok(requestInit?.signal instanceof AbortSignal);
    assert.ok(isRecord(requestBody));
    assert.equal(requestBody.model, "deepseek-v4-flash");
    assert.deepEqual(requestBody.thinking, { type: "disabled" });
    assert.deepEqual(requestBody.response_format, { type: "json_object" });
    assert.match(JSON.stringify(requestBody.messages), /pattern/);
    assert.match(JSON.stringify(requestBody.messages), /non-empty single-line strings/);
    assert.match(JSON.stringify(requestBody.messages), /all generated prose in Japanese/);
    assert.equal(draft.slug, "project-notes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateDraft preserves long sources up to the configured raw character limit", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return Response.json({ choices: [{ message: { content: draftJson } }] });
  };
  try {
    const longCode = `def main():\n${"    await work()\n".repeat(2_100)}`;
    await generateDraft({ ...source(), content: longCode }, [], config(), "deepseek-key");
    await generateDraft({ ...source(), content: "x".repeat(120_001) }, [], config(), "deepseek-key");

    const firstMessages = requestBodies[0]?.messages;
    const secondMessages = requestBodies[1]?.messages;
    assert.ok(Array.isArray(firstMessages) && Array.isArray(secondMessages));
    const firstUser = firstMessages.find((message) => isRecord(message) && message.role === "user");
    const secondUser = secondMessages.find((message) => isRecord(message) && message.role === "user");
    assert.ok(isRecord(firstUser) && typeof firstUser.content === "string");
    assert.ok(isRecord(secondUser) && typeof secondUser.content === "string");
    assert.equal((JSON.parse(firstUser.content) as { raw_content: string }).raw_content, longCode);
    assert.equal((JSON.parse(secondUser.content) as { raw_content: string }).raw_content.length, 120_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek 429 is retryable and honors bounded Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> =>
    Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "900" } });
  try {
    await assert.rejects(
      generateDraft(source(), [], config(), "deepseek-key"),
      (error: unknown) =>
        error instanceof DeepSeekRequestError &&
        error.code === "deepseek_http_429" &&
        error.retryable &&
        error.retryAfterSeconds === 300 &&
        error.message === "DeepSeek request failed: 429"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek 503 honors an HTTP-date Retry-After", async () => {
  const retryAt = new Date(Date.now() + 120_000).toUTCString();
  const error = await deepSeekFailure(503, retryAt);

  assert.ok(error instanceof DeepSeekRequestError);
  assert.equal(error.code, "deepseek_http_503");
  assert.ok((error.retryAfterSeconds ?? 0) >= 118 && (error.retryAfterSeconds ?? 0) <= 120);
});

test("past and invalid Retry-After values fall back to jitter", async () => {
  const past = await deepSeekFailure(429, "Wed, 21 Oct 2015 07:28:00 GMT");
  const invalid = await deepSeekFailure(503, "later");

  assert.ok(past instanceof DeepSeekRequestError && past.retryAfterSeconds === undefined);
  assert.ok(invalid instanceof DeepSeekRequestError && invalid.retryAfterSeconds === undefined);
});

test("DeepSeek failure diagnostics include sizes without request content or secrets", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  globalThis.fetch = async (): Promise<Response> => new Response("overloaded", { status: 503, statusText: "Service Unavailable" });
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    await assert.rejects(generateDraft({ ...source(), content: "private-source-marker" }, [], config(), "private-api-key"), DeepSeekRequestError);

    assert.equal(warnings.length, 1);
    const diagnostic = JSON.parse(warnings[0] ?? "{}") as Record<string, unknown>;
    assert.equal(diagnostic.event, "deepseek_request_failed");
    assert.equal(diagnostic.status, 503);
    assert.equal(diagnostic.model, "deepseek-v4-flash");
    assert.equal(typeof diagnostic.inputCharacters, "number");
    assert.equal(typeof diagnostic.requestBytes, "number");
    assert.equal(diagnostic.retryable, true);
    assert.doesNotMatch(warnings[0] ?? "", /private-source-marker|private-api-key|overloaded/);
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek responses larger than 256 KiB are rejected before JSON parsing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => new Response("x".repeat(256 * 1024 + 1));
  try {
    await assert.rejects(
      generateDraft(source(), [], config(), "deepseek-key"),
      (error: unknown) => error instanceof DeepSeekRequestError && error.code === "deepseek_response_too_large" && error.retryable
    );
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
    canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
    icHost: "https://icp0.io",
    model: "deepseek-v4-flash",
    targetRoot: "/Knowledge/conversations",
    sourcePrefix: "/Sources",
    contextPrefix: "/",
    maxRawChars: 120_000,
    maxFetchedBytes: 5_000_000,
    maxSourceChars: 300_000,
    maxContextHits: 8,
    maxOutputTokens: 6_000
  };
}

async function deepSeekFailure(status: number, retryAfter: string): Promise<unknown> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> =>
    Response.json({ error: { message: "temporary" } }, { status, headers: { "retry-after": retryAfter } });
  try {
    await generateDraft(source(), [], config(), "deepseek-key");
    throw new Error("DeepSeek failure expected");
  } catch (error) {
    return error;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function source() {
  return {
    path: "/Sources/a/a.md",
    kind: "source" as const,
    content: "raw",
    etag: "etag-1",
    metadataJson: "{}"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
