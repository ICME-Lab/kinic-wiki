import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "@/components/markdown-preview";
import { pdfPagesToMarkdown, pdfTextItemsToPlainText } from "@/lib/pdf-folder-import";

describe("PDF folder import formatting", () => {
  it("preserves text item contents and uses only explicit line endings", () => {
    expect(pdfTextItemsToPlainText([
      { str: "日", hasEOL: false },
      { str: "本", hasEOL: false },
      { str: "語", hasEOL: true },
      { str: "Hello ", hasEOL: false },
      { str: "world", hasEOL: false },
      { str: ",", hasEOL: false }
    ])).toBe("日本語\nHello world,");
    expect(pdfTextItemsToPlainText([
      { str: " leading and trailing ", hasEOL: false }
    ])).toBe(" leading and trailing ");
  });

  it("renders deterministic page sections and marks empty pages", () => {
    expect(pdfPagesToMarkdown("manual.pdf", ["First page", ""])).toBe([
      "# manual",
      "<!-- Text extracted locally. Original PDF is not stored. -->",
      "## Page 1\n\nFirst page",
      "## Page 2\n\n_No extractable text on this page._"
    ].join("\n\n"));
  });

  it("renders extracted PDF text as literal prose without active Markdown", () => {
    const content = pdfPagesToMarkdown("manual ![title](https://example.invalid/title).pdf", [[
      "![image](https://example.invalid/a)",
      "[link](https://example.invalid/b)",
      "[[/Knowledge/private.md]]",
      "# heading",
      "> quote",
      "```ts",
      "const value = 1;",
      "```",
      "https://example.invalid/c",
      "www.example.invalid",
      "person@example.invalid",
      "first  ",
      "    indented",
      "last"
    ].join("\n")]);

    const html = renderToStaticMarkup(createElement(MarkdownPreview, {
      canisterId: "aaaaa-aa",
      databaseId: "db-1",
      nodePath: "/Knowledge/manual.md",
      content
    })).replaceAll("\u2060", "");

    expect(html).not.toMatch(/<(?:a|img|blockquote|pre|code)\b/);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html.match(/<h2>/g)).toHaveLength(1);
    expect(html).toContain("![image](https://example.invalid/a)");
    expect(html).toContain("[link](https://example.invalid/b)");
    expect(html).toContain("[[/Knowledge/private.md]]");
    expect(html).toContain("# heading");
    expect(html).toContain("https://example.invalid/c");
    expect(html).toContain("person@example.invalid");
  });
});
