import { describe, expect, it } from "vitest";
import { markdownBody, wikiSeoNodeSummary } from "./wiki-seo";
import type { WikiNode } from "./types";

function node(content: string, metadataJson = "{}"): WikiNode {
  return { path: "/Knowledge/note.md", kind: "file", content, metadataJson, etag: "e", createdAt: "0", updatedAt: "0" };
}

describe("bounded SEO summaries", () => {
  it("uses frontmatter before JSON and body headings, without including frontmatter in the excerpt", () => {
    const summary = wikiSeoNodeSummary(null, "/Knowledge/note.md", node("---\ntitle: Frontmatter\ndescription: A description\n---\n# Heading\n[Link](https://example.com) **Body**", '{"title":"JSON"}'), []);
    expect(summary).toEqual({ title: "Frontmatter - Kinic Wiki", description: "A description", textExcerpt: "Heading Link Body" });
  });

  it("bounds the body and avoids serializing a long document's tail", () => {
    const input = node("# Heading\n" + "body ".repeat(200_000) + "TAIL_SENTINEL");
    const summary = wikiSeoNodeSummary(null, input.path, input, []);
    expect(summary.textExcerpt.length).toBeLessThanOrEqual(8000);
    expect(summary.description.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(summary)).not.toContain("TAIL_SENTINEL");
    expect(markdownBody(input.content).length).toBe(8000);
  });

  it("does not expose incomplete or oversized frontmatter as body text", () => {
    const input = node("---\ninternal: " + "x".repeat(20_000) + "\n---\n# Body");
    const summary = wikiSeoNodeSummary(null, input.path, input, []);
    expect(summary.textExcerpt).not.toContain("internal");
    expect(summary.title).toBe("note - Kinic Wiki");
  });

  it("falls back safely for malformed or oversized JSON", () => {
    for (const metadataJson of ["{", JSON.stringify({ title: "x".repeat(20_000) })]) {
      expect(wikiSeoNodeSummary(null, "/Knowledge/note.md", node("# Body", metadataJson), []).title).toBe("Body - Kinic Wiki");
    }
  });

  it("keeps folder descriptions and the database fallback title", () => {
    expect(wikiSeoNodeSummary(null, "/Knowledge", null, [], "db_alpha").title).toBe("Knowledge - db_alpha");
  });
});
