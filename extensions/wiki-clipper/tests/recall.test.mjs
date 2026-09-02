// Where: extensions/wiki-clipper/tests/recall.test.mjs
// What: Pure Recall ranking and context-format tests.
// Why: Search policy must remain deterministic and independent of browser state.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecallFallbackQuery,
  buildRecallSearchQuery,
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

test("buildRecallSearchQuery distills a Japanese draft into distinctive terms", () => {
  assert.equal(
    buildRecallSearchQuery("MCPを使ったAIエージェントの長期記憶をどう設計する？"),
    "設計 長期記憶 エージェント MCP"
  );
  assert.equal(buildRecallSearchQuery("検索精度を改善したいです"), "改善 検索精度");
});

test("buildRecallSearchQuery keeps ASCII identifiers and drops English stopwords", () => {
  assert.equal(
    buildRecallSearchQuery("please tell me more about the new API and search speed"),
    "speed search API new"
  );
  assert.equal(buildRecallSearchQuery("compare GPT-4 and pre-design-md"), "pre-design-md GPT-4 compare");
});

test("buildRecallSearchQuery returns null for function-only drafts", () => {
  assert.equal(buildRecallSearchQuery("please tell me more about it"), null);
  assert.equal(buildRecallSearchQuery("これについてどう思いますか"), null);
});

test("buildRecallSearchQuery caps the number of query terms from the end", () => {
  const query = buildRecallSearchQuery("長期記憶 設計 MCP API エージェント 検索 改善 精度 応用");
  assert.equal(query, "応用 精度 改善 検索");
});

test("buildRecallSearchQuery focuses on the most recent part of a long draft", () => {
  const prefix = `${"前置き".repeat(60)} `;
  const query = buildRecallSearchQuery(`${prefix}最終的な質問は長期記憶の設計についてです`);
  assert.ok(query && query.includes("長期記憶") && query.includes("設計"));
  assert.ok(query.split(" ").length <= 4);
});


test("rankRecallHits prefers Knowledge, dedupes paths, and removes path-only hits", () => {
  const results = rankRecallHits([
    hit("/Sources/chatgpt/one.md", ["content_fts"], -20_000, "source"),
    hit("/Knowledge/one.md", ["title_fts"], -30_000, "knowledge"),
    hit("/Knowledge/one.md", ["content_fts"], -25_000, "duplicate"),
    hit("/Knowledge/path-only.md", ["path_exact"], -1, "weak")
  ]);
  assert.deepEqual(results.map((result) => result.path), ["/Knowledge/one.md", "/Sources/chatgpt/one.md"]);
  assert.equal(results[0].score, -30_000);
  assert.deepEqual(results[0].matchReasons, ["title_fts", "content_fts"]);
});

test("rankRecallHits keeps content_substring hits so CJK body matches are not dropped", () => {
  const results = rankRecallHits([
    hit("/Knowledge/日本語ノート.md", ["content_substring"], -100_000_000, "検索改善の作業メモ", { charOffset: 12 })
  ]);
  assert.deepEqual(results.map((result) => result.path), ["/Knowledge/日本語ノート.md"]);
  assert.equal(results[0].charOffset, 12);
});

test("rankRecallHits keeps path_substring hits and still drops other path-only reasons", () => {
  const results = rankRecallHits([
    hit("/Knowledge/path-has-term.md", ["path_substring"], -100_000_000, "/Knowledge/path-has-term.md"),
    hit("/Knowledge/exact.md", ["path_exact"], -600_000_000, "exact"),
    hit("/Knowledge/prefix.md", ["basename_prefix"], -400_000_000, "prefix")
  ]);
  assert.deepEqual(results.map((result) => result.path), ["/Knowledge/path-has-term.md"]);
});

test("rankRecallHits merges duplicates keeping the best score and union reasons", () => {
  const results = rankRecallHits([
    hit("/Knowledge/agent.md", ["content_fts"], -1_500, "weak literal", { charOffset: 2 }),
    hit("/Knowledge/agent.md", ["content_substring"], -50_000, "strong fallback", { charOffset: 120 })
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].score, -50_000);
  assert.deepEqual(results[0].matchReasons, ["content_fts", "content_substring"]);
  assert.equal(results[0].snippet, "strong fallback");
  assert.equal(results[0].charOffset, 120);
});

test("rankRecallHits prefers a content preview over a path preview on merge", () => {
  const results = rankRecallHits([
    hit("/Knowledge/agent.md", ["path_substring"], -10_000, "", { field: "Path" }),
    hit("/Knowledge/agent.md", ["content_fts"], -20_000, "body excerpt", { charOffset: 40 })
  ]);
  assert.equal(results[0].snippet, "body excerpt");
  assert.equal(results[0].charOffset, 40);
  assert.equal(results[0].previewField, "Content");
});

test("rankRecallHits keeps the first hit when a duplicate claims a conflicting kind", () => {
  const results = rankRecallHits([
    hit("/Knowledge/agent.md", ["content_fts"], -10_000, "file body"),
    hit("/Knowledge/agent.md", ["content_fts"], -50_000, "folder body", { kind: { Folder: null } })
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "File");
  assert.equal(results[0].score, -10_000);
});

test("rankRecallHits keeps near-zero bm25-scale content scores for common terms", () => {
  // The canister returns content_fts scores of rank * 10_000, where bm25
  // magnitude shrinks as a term becomes common in the store. A score near zero
  // (e.g. -0.01) must still be a valid recall candidate.
  const common = hit("/Knowledge/mcp.md", ["content_fts"], -0.01, "body");
  const rare = hit("/Knowledge/mcp.md", ["content_fts"], -10_000, "body");
  assert.deepEqual(rankRecallHits([common]).map((result) => result.path), ["/Knowledge/mcp.md"]);
  assert.deepEqual(rankRecallHits([rare]).map((result) => result.path), ["/Knowledge/mcp.md"]);
  assert.equal(rankRecallHits([common])[0].score, -0.01);
});

test("rankRecallHits drops hits without a finite score", () => {
  const nanScore = hit("/Knowledge/mcp.md", ["content_fts"], Number.NaN, "body");
  const infScore = hit("/Knowledge/mcp.md", ["content_fts"], Number.POSITIVE_INFINITY, "body");
  const noScore = hit("/Knowledge/mcp.md", ["content_fts"], undefined, "body");
  assert.deepEqual(rankRecallHits([nanScore]), []);
  assert.deepEqual(rankRecallHits([infScore]), []);
  assert.deepEqual(rankRecallHits([noScore]), []);
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

test("normalizeRecallHit keeps a content char offset and nulls path previews", () => {
  const content = normalizeRecallHit({
    path: "/Knowledge/mcp.md",
    kind: { File: null },
    match_reasons: ["content_fts"],
    score: -10,
    preview: [{ field: { Content: null }, char_offset: 123, match_reason: "content_fts", excerpt: ["excerpt"] }],
    snippet: []
  });
  assert.equal(content.charOffset, 123);
  assert.equal(content.previewField, "Content");
  const pathOnly = normalizeRecallHit({
    path: "/Knowledge/mcp.md",
    kind: { File: null },
    match_reasons: ["path_substring"],
    score: -10,
    preview: [{ field: { Path: null }, char_offset: 7, match_reason: "path_substring", excerpt: [] }],
    snippet: []
  });
  assert.equal(pathOnly.charOffset, null);
  assert.equal(pathOnly.previewField, "Path");
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
  }, "sync"), {
    databaseId: "new-db",
    recallEnabled: true
  });
  assert.deepEqual(applyRecallStorageChanges(config, {
    recallEnabled: { newValue: true }
  }, "local"), config);
});

test("titleFromPath derives a readable title", () => {
  assert.equal(titleFromPath("/Knowledge/agent_memory-note.md"), "agent memory note");
});

function hit(path, reasons, score, excerpt, options = {}) {
  const field = options.field || "Content";
  return {
    path,
    kind: options.kind || { File: null },
    match_reasons: reasons,
    score,
    preview: [{ field: { [field]: null }, char_offset: options.charOffset ?? 0, match_reason: reasons[0], excerpt: [excerpt] }],
    snippet: [options.snippet !== undefined ? options.snippet : excerpt]
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
