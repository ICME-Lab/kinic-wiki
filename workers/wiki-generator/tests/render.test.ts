// Where: workers/wiki-generator/tests/render.test.ts
// What: Markdown render, slug, and target conflict tests.
// Why: Existing pages must not be overwritten without matching provenance.
import assert from "node:assert/strict";
import test from "node:test";
import { ensureTargetCanBeWritten, renderGeneratedMarkdown, slugForGeneratedPage } from "../src/render.js";
import type { WikiDraft, WikiNode } from "../src/types.js";

const source: WikiNode = {
  path: "/Sources/raw/a/a.md",
  kind: "source",
  content: "raw",
  etag: "etag-1",
  metadataJson: "{}"
};

const draft: WikiDraft = {
  title: "Project Notes!",
  slug: "Project Notes!",
  summary: "Summary",
  key_facts: [{ text: "Fact", source_path: source.path }],
  decisions: [],
  open_questions: [],
  follow_ups: []
};

test("slug and markdown include generated provenance without draft state", () => {
  assert.equal(slugForGeneratedPage(draft), "project-notes");
  const markdown = renderGeneratedMarkdown(draft, source, []);
  assert.doesNotMatch(markdown, /State: Draft/);
  assert.doesNotMatch(markdown, /## Status/);
  assert.match(markdown, /source_path: \/Sources\/raw\/a\/a\.md/);
});

test("target conflict requires matching provenance", () => {
  assert.doesNotThrow(() => ensureTargetCanBeWritten(null, "/Wiki/conversations/a.md", source.path));
  assert.doesNotThrow(() => ensureTargetCanBeWritten(`source_path: ${source.path}`, "/Wiki/conversations/a.md", source.path));
  assert.throws(() => ensureTargetCanBeWritten("source_path: /Sources/raw/b/b.md", "/Wiki/conversations/a.md", source.path), /without matching provenance/);
});
