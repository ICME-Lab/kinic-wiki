// Where: extensions/wiki-clipper/tests/evidence-source.test.mjs
// What: Unit tests for evidence source rendering.
// Why: Canister source writes must use canonical paths and stable markdown.
import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidenceSource } from "../src/evidence-source.js";

test("buildEvidenceSource emits canonical source path and metadata", () => {
  const raw = buildEvidenceSource(
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

  assert.match(raw.path, /^\/Sources\/chatgpt\/project-chat-[a-f0-9]{8}\.md$/);
  assert.doesNotMatch(raw.path, /abc\.md$/);
  assert.match(raw.content, /# Evidence Conversation Source/);
  assert.match(raw.content, /- message_count: 2/);
  assert.match(raw.content, /- truncated: false/);
  assert.match(raw.content, /- original_chars: 73/);
  assert.match(raw.content, /- saved_chars: 73/);
  assert.match(raw.content, /### Turn 0001/);
  const metadata = JSON.parse(raw.metadataJson);
  assert.equal(metadata.provider, "chatgpt");
  assert.equal(metadata.conversation_id, "abc");
  assert.equal(metadata.message_count, 2);
  assert.equal(metadata.truncated, false);
  assert.equal(metadata.original_chars, 73);
  assert.equal(metadata.saved_chars, 73);
});

test("buildEvidenceSource keeps the same path for the same ChatGPT conversation", () => {
  const first = buildEvidenceSource({
    provider: "chatgpt",
    conversationTitle: "Project Chat",
    url: "https://chatgpt.com/c/stable-id",
    capturedAt: "2026-05-01T00:00:00.000Z",
    messages: [{ role: "user", content: "Hello" }]
  });
  const second = buildEvidenceSource({
    provider: "chatgpt",
    conversationTitle: "Project Chat",
    url: "https://chatgpt.com/c/stable-id",
    capturedAt: "2026-05-01T01:00:00.000Z",
    messages: [{ role: "user", content: "Hello again" }]
  });

  assert.equal(first.path, second.path);
});

test("buildEvidenceSource keeps a stable path for Claude conversations", () => {
  const raw = buildEvidenceSource({
    provider: "claude",
    conversationTitle: "Claude Project",
    url: "https://claude.ai/chat/claude-abc",
    capturedAt: "2026-05-01T00:00:00.000Z",
    messages: [{ role: "user", content: "Hello" }]
  });

  assert.match(raw.path, /^\/Sources\/claude\/claude-project-[a-f0-9]{8}\.md$/);
  assert.equal(JSON.parse(raw.metadataJson).conversation_id, "claude-abc");
});

test("buildEvidenceSource truncates long conversation ids to a canonical source filename", () => {
  const longId = `conversation-${"a".repeat(220)}`;
  const raw = buildEvidenceSource({
    provider: "chatgpt",
    conversationTitle: "Long ID",
    url: `https://chatgpt.com/c/${longId}`,
    capturedAt: "2026-05-01T00:00:00.000Z",
    messages: [{ role: "user", content: "Hello" }]
  });
  const fileName = raw.path.split("/").at(-1);

  assert.match(raw.path, /^\/Sources\/chatgpt\/long-id-[a-f0-9]{8}\.md$/);
  assert.equal(new TextEncoder().encode(fileName.replace(/\.md$/, "")).length <= 128, true);
  assert.equal(JSON.parse(raw.metadataJson).conversation_id, longId);
});

test("buildEvidenceSource removes dotdot from conversation source filenames", () => {
  const raw = buildEvidenceSource({
    provider: "chatgpt",
    conversationTitle: "A..B",
    url: "https://chatgpt.com/c/a..b",
    capturedAt: "2026-05-01T00:00:00.000Z",
    messages: [{ role: "user", content: "Hello" }]
  });

  assert.match(raw.path, /^\/Sources\/chatgpt\/a-b-[a-f0-9]{8}\.md$/);
});

test("buildEvidenceSource preserves unicode title slugs", () => {
  const raw = buildEvidenceSource({
    provider: "chatgpt",
    conversationTitle: "会議 メモ",
    url: "https://chatgpt.com/c/unicode-title",
    capturedAt: "2026-05-01T00:00:00.000Z",
    messages: [{ role: "user", content: "Hello" }]
  });

  assert.match(raw.path, /^\/Sources\/chatgpt\/会議-メモ-[a-f0-9]{8}\.md$/);
});

test("buildEvidenceSource rejects empty captures", () => {
  assert.throws(
    () =>
      buildEvidenceSource({
        provider: "chatgpt",
        conversationTitle: "Empty",
        url: "https://chatgpt.com/c/empty",
        capturedAt: "2026-05-01T00:00:00.000Z",
        messages: []
      }),
    /no conversation messages/
  );
});

test("buildEvidenceSource escapes one-line markdown metadata values", () => {
  const raw = buildEvidenceSource({
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

test("buildEvidenceSource truncates oversized conversation source text", () => {
  const raw = buildEvidenceSource({
    provider: "chatgpt",
    conversationTitle: "Large",
    url: "https://chatgpt.com/c/large",
    capturedAt: "2026-05-01T00:00:00.000Z",
    messages: [
      { role: "user", content: "a".repeat(180_000) },
      { role: "assistant", content: `${"b".repeat(180_000)}SHOULD_NOT_BE_SAVED` }
    ]
  });

  const metadata = JSON.parse(raw.metadataJson);
  assert.equal(metadata.truncated, true);
  assert.equal(metadata.original_chars > 300_000, true);
  assert.equal(metadata.saved_chars, 300_000);
  assert.match(raw.content, /- truncated: true/);
  assert.match(raw.content, /- original_chars: [3-9][0-9]{5}/);
  assert.match(raw.content, /- saved_chars: 300000/);
  assert.doesNotMatch(raw.content, /SHOULD_NOT_BE_SAVED/);
});
