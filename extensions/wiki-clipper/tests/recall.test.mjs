// Where: extensions/wiki-clipper/tests/recall.test.mjs
// What: Pure Recall ranking and context-format tests.
// Why: Search policy must remain deterministic and independent of browser state.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecallFallbackQuery,
  applyRecallStorageChanges,
  formatRecallContext,
  isAllowedRecallPath,
  isChatGptOrigin,
  isRecallSender,
  normalizeRecallQuery,
  rankRecallHits,
  titleFromPath
} from "../src/recall.js";

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
    hit("/Sources/chatgpt/one.md", ["content_fts"], -10, "source"),
    hit("/Knowledge/one.md", ["title_fts"], -30, "knowledge"),
    hit("/Knowledge/one.md", ["content_fts"], -5, "duplicate"),
    hit("/Knowledge/path-only.md", ["path_exact"], -1, "weak")
  ]);
  assert.deepEqual(results.map((result) => result.path), ["/Knowledge/one.md", "/Sources/chatgpt/one.md"]);
});

test("rankRecallHits excludes a path containing the current ChatGPT conversation id", () => {
  const results = rankRecallHits([hit("/Sources/chatgpt/abc.md", ["content_fts"], -1, "current")], {
    currentConversationUrl: "https://chatgpt.com/c/abc"
  });
  assert.deepEqual(results, []);
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
