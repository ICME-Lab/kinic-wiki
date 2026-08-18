// Where: extensions/wiki-clipper/tests/recall.test.mjs
// What: Pure Recall ranking and context-format tests.
// Why: Search policy must remain deterministic and independent of browser state.
import assert from "node:assert/strict";
import test from "node:test";
import {
  RECALL_MIN_SCORE,
  buildRecallFallbackQuery,
  applyRecallStorageChanges,
  formatRecallContext,
  isAllowedRecallPath,
  isChatGptOrigin,
  isRecallSender,
  normalizeRecallHit,
  normalizeRecallQuery,
  rankRecallHits,
  titleFromPath
} from "../src/recall.js";
import { buildEvidenceSource } from "../src/evidence-source.js";

test("buildRecallFallbackQuery keeps compact ASCII anchors and a Japanese term", () => {
  assert.equal(
    buildRecallFallbackQuery("MCPを使ったAIエージェントの長期記憶をどう設計する？"),
    "MCP 長期記憶"
  );
  assert.equal(buildRecallFallbackQuery("GPT-4とpre-design-mdの比較"), "GPT-4 pre-design-md");
  assert.equal(buildRecallFallbackQuery("エージェントの使い方"), "エージェント");
});

test("buildRecallFallbackQuery returns null when no useful fallback exists", () => {
  assert.equal(buildRecallFallbackQuery("どう設計する？"), null);
  assert.equal(buildRecallFallbackQuery("MCP"), null);
});

test("normalizeRecallQuery collapses whitespace and caps the query", () => {
  assert.equal(normalizeRecallQuery("  previous\n   MCP   notes  "), "previous MCP notes");
  assert.equal(normalizeRecallQuery("x".repeat(2_100)).length, 2_000);
});

test("rankRecallHits prefers Knowledge, dedupes paths, and removes path-only hits", () => {
  const results = rankRecallHits([
    hit("/Sources/chatgpt/one.md", ["content_fts"], -20_000, "source"),
    hit("/Knowledge/one.md", ["title_fts"], -30_000, "knowledge"),
    hit("/Knowledge/one.md", ["content_fts"], -25_000, "duplicate"),
    hit("/Knowledge/path-only.md", ["path_exact"], -1, "weak")
  ]);
  assert.deepEqual(results.map((result) => result.path), ["/Knowledge/one.md", "/Sources/chatgpt/one.md"]);
});

test("rankRecallHits drops weak FTS matches below the minimum score", () => {
  const strong = hit("/Knowledge/mcp.md", ["content_fts"], -10_000, "body");
  const weak = hit("/Knowledge/mcp.md", ["content_fts"], -100, "weak body");
  assert.deepEqual(rankRecallHits([weak]).map((result) => result.path), []);
  assert.deepEqual(rankRecallHits([strong]).map((result) => result.path), ["/Knowledge/mcp.md"]);
  assert.ok(RECALL_MIN_SCORE < 0);
});

test("rankRecallHits excludes the current ChatGPT conversation source path", () => {
  const source = chatgptSource("https://chatgpt.com/c/abc", "Project Chat");
  const results = rankRecallHits([hit(source.path, ["content_fts"], -10_000, "current")], {
    currentConversationUrl: "https://chatgpt.com/c/abc"
  });
  assert.deepEqual(results, []);
});

test("rankRecallHits keeps another conversation's source path", () => {
  const source = chatgptSource("https://chatgpt.com/c/abc", "Project Chat");
  const results = rankRecallHits([hit(source.path, ["content_fts"], -10_000, "other")], {
    currentConversationUrl: "https://chatgpt.com/c/def"
  });
  assert.deepEqual(results.map((result) => result.path), [source.path]);
});

test("rankRecallHits excludes the current conversation for chat and app URL forms", () => {
  const source = chatgptSource("https://chatgpt.com/c/abc", "Project Chat");
  for (const url of [
    "https://chatgpt.com/chat/abc",
    "https://chatgpt.com/app/abc",
    "https://chatgpt.com/u/1/app/abc"
  ]) {
    const results = rankRecallHits([hit(source.path, ["content_fts"], -10_000, "current")], {
      currentConversationUrl: url
    });
    assert.deepEqual(results, [], `expected ${url} to exclude the current conversation`);
  }
});

test("normalizeRecallHit prefers the ContentStart preview excerpt over an empty snippet", () => {
  const result = normalizeRecallHit({
    path: "/Knowledge/mcp.md",
    kind: { File: null },
    match_reasons: ["content_fts"],
    score: -10,
    preview: [{ field: { Content: null }, char_offset: 0, match_reason: "content_start", excerpt: ["preview body"] }],
    snippet: []
  });
  assert.equal(result.snippet, "preview body");
});

test("normalizeRecallHit falls back to the snippet when preview is absent", () => {
  const result = normalizeRecallHit({
    path: "/Knowledge/mcp.md",
    kind: { File: null },
    match_reasons: ["title_fts"],
    score: -10,
    preview: [],
    snippet: ["snippet text"]
  });
  assert.equal(result.snippet, "snippet text");
});

test("formatRecallContext creates a bounded quoted block without HTML interpretation", () => {
  const text = formatRecallContext(
    { title: "MCP notes", path: "/Knowledge/mcp.md", sourceUrl: "https://wiki.kinic.xyz/db/db/Knowledge/mcp.md" },
    "<script>alert(1)</script>"
  );
  assert.match(text, /^\[Kinic memory\]/);
  assert.match(text, /Title: MCP notes/);
  assert.match(text, /Source: https:\/\/wiki\.kinic\.xyz/);
  assert.match(text, /<script>alert\(1\)<\/script>/);
  assert.match(text, /\[\/Kinic memory\]$/);
});

test("ChatGPT sender and origin checks fail closed", () => {
  assert.equal(isChatGptOrigin("https://chatgpt.com/c/abc"), true);
  assert.equal(isChatGptOrigin("https://claude.ai/chat/abc"), false);
  assert.equal(isRecallSender({ tab: { url: "https://chatgpt.com/c/abc" } }), true);
  assert.equal(isRecallSender({ tab: { url: "https://example.com/" } }), false);
});

test("isAllowedRecallPath restricts reads to Recall search prefixes", () => {
  assert.equal(isAllowedRecallPath("/Knowledge/mcp.md"), true);
  assert.equal(isAllowedRecallPath("/Sources/chatgpt/mcp.md"), true);
  assert.equal(isAllowedRecallPath("/Other/private.md"), false);
  assert.equal(isAllowedRecallPath("/Knowledge/../Other/private.md"), false);
  assert.equal(isAllowedRecallPath("Knowledge/mcp.md"), false);
});

test("applyRecallStorageChanges updates only sync Recall settings", () => {
  const config = { databaseId: "old-db", recallEnabled: false };
  assert.deepEqual(applyRecallStorageChanges(config, {
    databaseId: { newValue: "new-db" },
    recallEnabled: { newValue: "true" }
  }, "sync"), { databaseId: "new-db", recallEnabled: true });
  assert.deepEqual(applyRecallStorageChanges(config, {
    recallEnabled: { newValue: true }
  }, "local"), config);
});

test("titleFromPath derives a readable title", () => {
  assert.equal(titleFromPath("/Knowledge/agent_memory-note.md"), "agent memory note");
});

function hit(path, reasons, score, excerpt) {
  return {
    path,
    kind: { File: null },
    match_reasons: reasons,
    score,
    preview: [{ field: { Content: null }, char_offset: 0, match_reason: reasons[0], excerpt: [excerpt] }],
    snippet: [excerpt]
  };
}

function chatgptSource(url, conversationTitle) {
  return buildEvidenceSource({
    provider: "chatgpt",
    url,
    conversationTitle,
    capturedAt: "2026-05-01T00:00:00.000Z",
    messages: [{ role: "user", content: "Hello" }]
  });
}
