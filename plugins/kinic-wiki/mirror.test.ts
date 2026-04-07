import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { serializeMirrorFile } from "./frontmatter";
import { normalizePageMarkdown, normalizeSystemMarkdown } from "./links";
import { MirrorFrontmatter, SystemPageSnapshot, WikiPageSnapshot } from "./types";

test("page mirror output matches shared golden fixture", () => {
  const fixtureRoot = mirrorFixtureRoot();
  const pages = parsePagesFixture(readFixture(path.join(fixtureRoot, "pages.json")));
  const page = pages.find((entry) => entry.slug === "alpha");
  assert.ok(page);

  const actual = serializeMirrorFile(frontmatterFromPage(page), normalizePageMarkdown(page.markdown, knownSlugs(pages)));
  const expected = readFixture(path.join(fixtureRoot, "golden", "pages", "alpha.md"));
  assert.equal(actual, expected);
});

test("system page normalization matches shared golden fixture", () => {
  const fixtureRoot = mirrorFixtureRoot();
  const pages = parsePagesFixture(readFixture(path.join(fixtureRoot, "pages.json")));
  const systemPages = parseSystemPagesFixture(readFixture(path.join(fixtureRoot, "system_pages.json")));
  const indexPage = systemPages.find((entry) => entry.slug === "index.md");
  assert.ok(indexPage);

  const actual = normalizeSystemMarkdown(indexPage.markdown, knownSlugs(pages));
  const expected = readFixture(path.join(fixtureRoot, "golden", "index.md"));
  assert.equal(actual, expected);
});

function mirrorFixtureRoot(): string {
  return path.resolve(process.cwd(), "..", "..", "fixtures", "mirror_spec");
}

function readFixture(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function parsePagesFixture(content: string): WikiPageSnapshot[] {
  const input: unknown = JSON.parse(content);
  assert.ok(Array.isArray(input));
  return input.map(parsePageSnapshot);
}

function parseSystemPagesFixture(content: string): SystemPageSnapshot[] {
  const input: unknown = JSON.parse(content);
  assert.ok(Array.isArray(input));
  return input.map(parseSystemPageSnapshot);
}

function parsePageSnapshot(input: unknown): WikiPageSnapshot {
  assert.ok(isRecord(input));
  assert.ok(isString(input.page_id));
  assert.ok(isString(input.slug));
  assert.ok(isString(input.title));
  assert.ok(isPluginPageType(input.page_type));
  assert.ok(isString(input.revision_id));
  assert.ok(typeof input.updated_at === "number");
  assert.ok(isString(input.markdown));
  assert.ok(Array.isArray(input.section_hashes));
  return {
    page_id: input.page_id,
    slug: input.slug,
    title: input.title,
    page_type: input.page_type,
    revision_id: input.revision_id,
    updated_at: input.updated_at,
    markdown: input.markdown,
    section_hashes: input.section_hashes.map(parseSectionHashEntry)
  };
}

function parseSystemPageSnapshot(input: unknown): SystemPageSnapshot {
  assert.ok(isRecord(input));
  assert.ok(isString(input.slug));
  assert.ok(isString(input.markdown));
  assert.ok(typeof input.updated_at === "number");
  assert.ok(isString(input.etag));
  return {
    slug: input.slug,
    markdown: input.markdown,
    updated_at: input.updated_at,
    etag: input.etag
  };
}

function parseSectionHashEntry(input: unknown): { section_path: string; content_hash: string } {
  assert.ok(isRecord(input));
  assert.ok(isString(input.section_path));
  assert.ok(isString(input.content_hash));
  return {
    section_path: input.section_path,
    content_hash: input.content_hash
  };
}

function frontmatterFromPage(page: WikiPageSnapshot): MirrorFrontmatter {
  return {
    page_id: page.page_id,
    slug: page.slug,
    page_type: page.page_type,
    revision_id: page.revision_id,
    updated_at: page.updated_at,
    mirror: true
  };
}

function knownSlugs(pages: WikiPageSnapshot[]): Set<string> {
  return new Set(pages.map((page) => page.slug));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isString(input: unknown): input is string {
  return typeof input === "string";
}

function isPluginPageType(input: unknown): input is MirrorFrontmatter["page_type"] {
  return isString(input)
    && ["entity", "concept", "overview", "comparison", "query_note", "source_summary"].includes(input);
}
