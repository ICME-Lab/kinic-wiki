// Where: workers/wiki-generator/tests/render.test.ts
// What: Markdown render, slug, and target conflict tests.
// Why: Existing pages must not be overwritten without matching provenance.
import assert from "node:assert/strict";
import test from "node:test";
import { ensureTargetCanBeWritten, renderGeneratedMarkdown, slugForGeneratedPage } from "../src/render.js";
import type { WikiDraft, WikiNode } from "../src/types.js";

const source: WikiNode = {
  path: "/Sources/evidence/a/a.md",
  kind: "source",
  content: "raw",
  etag: "etag-1",
  metadataJson: "{}"
};

const draft: WikiDraft = {
  title: "Project Notes!",
  slug: "Project Notes!",
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
  summary: "Summary",
  key_facts: [{ text: "Fact", source_path: source.path }],
  decisions: [],
  open_questions: [],
  follow_ups: []
};

test("slug and markdown include generated provenance without status frontmatter", () => {
  assert.equal(slugForGeneratedPage(draft, "web-abc123"), "project-notes");
  const markdown = renderGeneratedMarkdown(draft, source, []);
  assert.doesNotMatch(markdown, /^---\n/m);
  assert.doesNotMatch(markdown, /## Status/);
  assert.match(markdown, /source_path: \/Sources\/evidence\/a\/a\.md/);
  assert.match(markdown, /source_etag: etag-1/);
});

test("Japanese-only generated slug is preserved as the page slug", () => {
  assert.equal(
    slugForGeneratedPage(
      {
        ...draft,
        title: "日本語記事",
        slug: "日本語記事"
      },
      "web-abc123"
    ),
    "日本語記事"
  );
});

test("unusable generated slug falls back to source-derived slug", () => {
  assert.equal(
    slugForGeneratedPage(
      {
        ...draft,
        title: "..",
        slug: "/"
      },
      "web-abc123"
    ),
    "web-abc123"
  );
});

test("generated slug is normalized as a single safe filename segment", () => {
  assert.equal(
    slugForGeneratedPage(
      {
        ...draft,
        title: "ignored",
        slug: "日本語 / Project\u0000Notes.md"
      },
      "web-abc123"
    ),
    "日本語-project-notes"
  );
});

test("generated slug normalizes Unicode and strips bidi controls", () => {
  assert.equal(
    slugForGeneratedPage(
      {
        ...draft,
        title: "ignored",
        slug: "Cafe\u0301"
      },
      "web-abc123"
    ),
    "café"
  );
  assert.equal(
    slugForGeneratedPage(
      {
        ...draft,
        title: "ignored",
        slug: "safe\u202Eevil"
      },
      "web-abc123"
    ),
    "safeevil"
  );
});

test("VFS path links are escaped for Markdown destinations", () => {
  const markdown = renderGeneratedMarkdown(
    {
      ...draft,
      key_facts: [{ text: "Fact", source_path: "/Sources/evidence/web/a]b.md" }]
    },
    { ...source, path: "/Sources/evidence/web/a]b.md" },
    [
      { path: "/Wiki/conversations/日本語 記事).md", kind: "file", previewExcerpt: null, snippet: null },
      { path: "/Wiki/space name.md", kind: "file", previewExcerpt: null, snippet: null },
      { path: "/Wiki/a#b.md", kind: "file", previewExcerpt: null, snippet: null },
      { path: "/Wiki/a?b.md", kind: "file", previewExcerpt: null, snippet: null },
      { path: "/Wiki/100%.md", kind: "file", previewExcerpt: null, snippet: null }
    ]
  );
  assert.match(markdown, /Source: \[\/Sources\/evidence\/web\/a\\\]b\.md\]\(<\/Sources\/evidence\/web\/a]b\.md>\)/);
  assert.match(markdown, /\[source\]\(<\/Sources\/evidence\/web\/a]b\.md>\)/);
  assert.match(markdown, /\[\/Wiki\/conversations\/日本語 記事\)\.md\]\(<\/Wiki\/conversations\/日本語 記事\)\.md>\)/);
  assert.match(markdown, /\[\/Wiki\/space name\.md\]\(<\/Wiki\/space name\.md>\)/);
  assert.match(markdown, /\[\/Wiki\/a#b\.md\]\(<\/Wiki\/a%23b\.md>\)/);
  assert.match(markdown, /\[\/Wiki\/a\?b\.md\]\(<\/Wiki\/a%3Fb\.md>\)/);
  assert.match(markdown, /\[\/Wiki\/100%\.md\]\(<\/Wiki\/100%25\.md>\)/);
});

test("draft-provided labels are rendered without worker language detection", () => {
  const markdown = renderGeneratedMarkdown(
    {
      ...draft,
      title: "日本語記事",
      labels: {
        summary: "概要",
        key_facts: "主要事実",
        decisions: "決定事項",
        open_questions: "未解決事項",
        follow_ups: "フォローアップ",
        related_context: "関連コンテキスト",
        provenance: "来歴",
        none: "なし"
      },
      summary: "日本語の要約",
      key_facts: [{ text: "本文は日本語で保持する。", source_path: source.path }]
    },
    { ...source, content: "# Source\n\nThe source language is not inspected by the renderer." },
    [{ path: "/Wiki/context.md", kind: "file", previewExcerpt: "関連", snippet: "" }]
  );
  assert.match(markdown, /## 概要/);
  assert.match(markdown, /## 主要事実/);
  assert.match(markdown, /## 関連コンテキスト/);
  assert.match(markdown, /## 来歴/);
  assert.doesNotMatch(markdown, /## Summary/);
  assert.doesNotMatch(markdown, /- none/);
});

test("target conflict requires matching provenance", () => {
  assert.doesNotThrow(() => ensureTargetCanBeWritten(null, "/Wiki/conversations/a.md", source.path));
  assert.doesNotThrow(() => ensureTargetCanBeWritten(`- source_path: ${source.path}`, "/Wiki/conversations/a.md", source.path));
  assert.throws(
    () => ensureTargetCanBeWritten(`# Existing\n\nMention ${source.path} in body only.`, "/Wiki/conversations/a.md", source.path),
    /without matching provenance/
  );
  assert.throws(() => ensureTargetCanBeWritten("source_path: /Sources/evidence/b/b.md", "/Wiki/conversations/a.md", source.path), /without matching provenance/);
});
