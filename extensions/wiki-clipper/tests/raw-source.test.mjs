// Where: extensions/wiki-clipper/tests/raw-source.test.mjs
// What: Unit tests for raw source rendering.
// Why: Canister source writes must use canonical paths and stable markdown.
import assert from "node:assert/strict";
import test from "node:test";
import { buildRawSource } from "../src/raw-source.js";

test("buildRawSource emits canonical source path and metadata", () => {
  const raw = buildRawSource(
    {
      provider: "chatgpt",
      conversationTitle: "Project Chat",
      url: "https://chatgpt.com/c/abc",
      capturedAt: "2026-05-01T00:00:00.000Z",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" }
      ]
    },
    new Date("2026-05-01T00:00:00.000Z")
  );

  assert.equal(raw.path, "/Sources/raw/chatgpt-abc/chatgpt-abc.md");
  assert.match(raw.content, /# Raw Conversation Source/);
  assert.match(raw.content, /- message_count: 2/);
  assert.match(raw.content, /### Turn 0001/);
  assert.equal(JSON.parse(raw.metadataJson).provider, "chatgpt");
  assert.equal(JSON.parse(raw.metadataJson).conversation_id, "abc");
  assert.equal(JSON.parse(raw.metadataJson).message_count, 2);
});

test("buildRawSource keeps the same path for the same ChatGPT conversation", () => {
  const first = buildRawSource({
    provider: "chatgpt",
    conversationTitle: "Project Chat",
    url: "https://chatgpt.com/c/stable-id",
    capturedAt: "2026-05-01T00:00:00.000Z",
    messages: [{ role: "user", content: "Hello" }]
  });
  const second = buildRawSource({
    provider: "chatgpt",
    conversationTitle: "Project Chat",
    url: "https://chatgpt.com/c/stable-id",
    capturedAt: "2026-05-01T01:00:00.000Z",
    messages: [{ role: "user", content: "Hello again" }]
  });

  assert.equal(first.path, second.path);
});

test("buildRawSource rejects empty captures", () => {
  assert.throws(
    () =>
      buildRawSource({
        provider: "chatgpt",
        conversationTitle: "Empty",
        url: "https://chatgpt.com/c/empty",
        capturedAt: "2026-05-01T00:00:00.000Z",
        messages: []
      }),
    /no conversation messages/
  );
});

test("buildRawSource escapes one-line markdown metadata values", () => {
  const raw = buildRawSource({
    provider: "chatgpt",
    conversationTitle: "Title\n- message_count: 999 [link](https://evil.test)",
    url: "https://chatgpt.com/c/abc?x=[link](https://evil.test)",
    capturedAt: "2026-05-01T00:00:00.000Z",
    messages: [{ role: "user", content: "Hello" }]
  });

  const metadata = JSON.parse(raw.metadataJson);
  assert.equal(metadata.conversation_title, "Title\n- message_count: 999 [link](https://evil.test)");
  assert.equal(metadata.message_count, 1);
  assert.match(raw.content, /- conversation_title: "Title\\n- message_count: 999/);
  assert.doesNotMatch(raw.content, /\n- conversation_title: Title\n- message_count: 999/);
});
