import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/lib/markdown-renderer";

function render(markdown: string, components?: Parameters<typeof Markdown>[0]["components"]): string {
  return renderToStaticMarkup(<Markdown components={components}>{markdown}</Markdown>);
}

describe("Markdown renderer", () => {
  it("renders ATX and setext headings", () => {
    const html = render("# H1\n\n## H2\n\n### H3\n\n#### H4\n\nSetext1\n===\n\nSetext2\n---");
    expect(html).toContain("<h1>H1</h1>");
    expect(html).toContain("<h2>H2</h2>");
    expect(html).toContain("<h3>H3</h3>");
    expect(html).toContain("<h4>H4</h4>");
    expect(html).toContain("<h1>Setext1</h1>");
    expect(html).toContain("<h2>Setext2</h2>");
  });

  it("renders inline emphasis, strong, code, and strikethrough", () => {
    const html = render("*em* **strong** `code` ~~del~~");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<del>del</del>");
  });

  it("renders links and images", () => {
    const html = render("[label](https://example.com) ![alt](https://example.com/a.png)");
    expect(html).toContain('<a href="https://example.com">label</a>');
    expect(html).toContain('<img src="https://example.com/a.png" alt="alt"/>');
  });

  it("keeps underscores in link text literal", () => {
    const html = render("[https://x.com/kinic_app](https://x.com/kinic_app)");
    expect(html).toContain('<a href="https://x.com/kinic_app">https://x.com/kinic_app</a>');
    expect(html).not.toContain("<em>");
  });

  it("renders fenced code blocks with language class", () => {
    const html = render("```ts\nconst value = 1;\n```");
    expect(html).toContain('<pre><code class="language-ts">const value = 1;');
  });

  it("keeps the line after an empty fenced code block", () => {
    const html = render("```\n```\n# After");
    expect(html).toContain("<h1>After</h1>");
  });

  it("absorbs the rest of the document into an unterminated fence", () => {
    const html = render("```ts\nconst value = 1;\n# After");
    expect(html).toContain('<pre><code class="language-ts">const value = 1;\n# After</code></pre>');
    expect(html).not.toContain("<h1>After</h1>");
  });

  it("ends a list before a horizontal rule", () => {
    const html = render("- Foo\n---");
    expect(html).toContain("<ul><li>Foo</li></ul>");
    expect(html).toContain("<hr/>");
    expect(html).not.toContain("<h2>");
  });

  it("ends a list before a heading and fence", () => {
    const heading = render("- Foo\n# Heading");
    expect(heading).toContain("<ul><li>Foo</li></ul>");
    expect(heading).toContain("<h1>Heading</h1>");
    const fence = render("- Foo\n```\ncode\n```");
    expect(fence).toContain("<ul><li>Foo</li></ul>");
    expect(fence).toContain("<pre><code>code</code></pre>");
  });

  it("keeps an indented heading inside a list item", () => {
    const html = render("- Foo\n  # Inside");
    expect(html).toContain("<ul><li>Foo<h1>Inside</h1></li></ul>");
  });

  it("does not add checkboxes to plain items in a mixed task list", () => {
    const html = render("- normal item\n- [x] completed item");
    expect(html).toContain("<ul><li>normal item</li>");
    expect(html).toContain("<li><input type=\"checkbox\" disabled=\"\" checked=\"\"/>completed item</li>");
  });

  it("renders hard line breaks from two trailing spaces and a backslash", () => {
    const twoSpaces = render("first  \nsecond");
    expect(twoSpaces).toContain("<p>first<br/>second</p>");
    const backslash = render("first\\\nsecond");
    expect(backslash).toContain("<p>first<br/>second</p>");
    expect(backslash).not.toContain("first\\");
  });

  it("renders ordered, unordered, and task lists", () => {
    const html = render([
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "- [x] done",
      "- [ ] todo"
    ].join("\n"));
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
    expect(html).toContain("done");
    expect(html).toContain("todo");
  });

  it("renders blockquote and horizontal rule", () => {
    const html = render("> quoted\n\n---");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(html).toContain("<hr/>");
  });

  it("renders GFM tables", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders table alignment for center/right columns", () => {
    const html = render("| a | b |\n|:---:|---:|\n| 1 | 2 |");
    expect(html).toContain('<th style="text-align:center">a</th>');
    expect(html).toContain('<th style="text-align:right">b</th>');
    expect(html).not.toContain("text-align:left");
  });

  it("resolves reference-style links", () => {
    const html = render('See [the reference][ref] and [shortcut][] and [implied].\n\n[ref]: https://example.com/ref "title"\n[shortcut]: https://example.com/s\n[implied]: https://example.com/i');
    expect(html).toContain('<a href="https://example.com/ref" title="title">the reference</a>');
    expect(html).toContain('<a href="https://example.com/s">shortcut</a>');
    expect(html).toContain('<a href="https://example.com/i">implied</a>');
  });

  it("nests nested list items", () => {
    const html = render("- one\n- two\n  - nested a\n  - nested b\n- three");
    expect(html).toContain("<li>two<ul><li>nested a</li><li>nested b</li></ul></li>");
  });

  it("renders autolinks for angle-bracket URLs", () => {
    const html = render("<https://example.com>");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it("decodes HTML entities into literal text", () => {
    const html = render("a &amp; b &#33; &#x41;");
    expect(html).toContain("<p>a &amp; b ! A</p>");
  });

  it("decodes common named entities", () => {
    const html = render("&copy; 2026 &mdash; &ldquo;quoted&rdquo; &times; 2");
    expect(html).toContain("<p>© 2026 — “quoted” × 2</p>");
  });

  it("autolinks bare http/https/ftp URLs", () => {
    const html = render("See https://example.com/a and http://x.example and ftp://files.example.org now.");
    expect(html).toContain('<a href="https://example.com/a">https://example.com/a</a>');
    expect(html).toContain('<a href="http://x.example">http://x.example</a>');
    expect(html).toContain('<a href="ftp://files.example.org">ftp://files.example.org</a>');
  });

  it("autolinks bare www and email, trimming trailing punctuation", () => {
    const html = render("Visit www.example.com, or mail me@example.com.");
    expect(html).toContain('<a href="http://www.example.com">www.example.com</a>');
    expect(html).toContain('<a href="mailto:me@example.com">me@example.com</a>');
  });

  it("does not autolink inside inline code or existing links", () => {
    const html = render("`https://example.com` [click https://example.com/x](https://example.com)");
    expect(html).toContain("<code>https://example.com</code>");
    expect(html).not.toContain("<a href=\"https://example.com/x\">click <a");
  });

  it("does not autolink version-like bare text", () => {
    const html = render("version v1.2.3 of the tool");
    expect(html).toContain("v1.2.3");
    expect(html).not.toContain("<a href");
  });

  it("honors component overrides", () => {
    const html = render("[x](https://x.com)", {
      a: ({ href, children }) => <span data-href={href}>{children}</span>
    });
    expect(html).toContain('<span data-href="https://x.com">x</span>');
  });
});
