import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicMarkdownPreview } from "@/components/public-markdown-preview";

function render(content: string): string {
  return renderToStaticMarkup(<PublicMarkdownPreview content={content} />);
}

describe("PublicMarkdownPreview", () => {
  it.each(["**bold**", "_italic_", "~~deleted~~", "&copy;", "`code`", "a\\b", "https://example.com", "![image](https://example.com/x.png)"])("keeps the label %s literal", (label) => {
    expect(render(`[[target|${label}]]`)).toBe(`<p><span>${label.replaceAll("&", "&amp;")}</span></p>`);
  });

  it("does not expose parser nodes on HTTPS images", () => {
    const html = render("![Safe](https://example.com/image.png)");
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).not.toContain(" node=");
  });

  it("renders wikilink aliases and embeds as literal text", () => {
    const html = render([
      "[[target|https://example.com]]",
      "",
      "[[target|# Visible text]]",
      "",
      "[[target|- list item]]",
      "",
      "![[image.png]]"
    ].join("\n"));

    expect(html).not.toContain("<a");
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("<img");
    expect(html).toContain("<p><span>https://example.com</span></p>");
    expect(html).toContain("<p><span># Visible text</span></p>");
    expect(html).toContain("<p><span>- list item</span></p>");
    expect(html).toContain("<p><span>image.png</span></p>");
  });

  it("preserves wikilink syntax inside inline and fenced code", () => {
    const html = render([
      "`[[literal inline]]`",
      "",
      "```md",
      "[[literal fenced]]",
      "```"
    ].join("\n"));

    expect(html).toContain("<code>[[literal inline]]</code>");
    expect(html).toContain("[[literal fenced]]");
  });

  it("keeps only external HTTPS Markdown links interactive", () => {
    const html = render([
      "[External](https://example.com/reference)",
      "",
      "[Internal](./private.md)",
      "",
      "[Insecure](http://example.com)"
    ].join("\n"));

    expect(html).toContain('<a href="https://example.com/reference"');
    expect(html).toContain("<span>Internal</span>");
    expect(html).toContain("<span>Insecure</span>");
  });

  it("keeps unsafe HTML and destinations non-executable", () => {
    const html = render([
      "[Unsafe](javascript:alert(1))",
      "",
      "![Unsafe image](data:text/html,boom)",
      "",
      '<script>alert(2)</script><img src="x" onerror="alert(3)">'
    ].join("\n"));

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain("Unsafe image");
    expect(html).toContain("&lt;script&gt;");
  });

  it("removes only a leading Markdown heading", () => {
    const html = render("# Hidden title\n\nVisible paragraph\n\n## Visible subheading");

    expect(html).not.toContain("Hidden title");
    expect(html).toContain("<p>Visible paragraph</p>");
    expect(html).toContain("<h2>Visible subheading</h2>");
  });

  it("removes a leading Setext heading", () => {
    const html = render("Hidden title\n============\n\nVisible paragraph");

    expect(html).not.toContain("Hidden title");
    expect(html).toContain("<p>Visible paragraph</p>");
  });

  it("removes a leading heading after blank lines", () => {
    const html = render("\n\n# Hidden title\n\nVisible paragraph");

    expect(html).not.toContain("Hidden title");
    expect(html).toContain("<p>Visible paragraph</p>");
  });

  it("removes a leading Setext H2 heading", () => {
    const html = render("Hidden title\n---\n\nVisible paragraph");

    expect(html).not.toContain("Hidden title");
    expect(html).not.toContain("<h2>");
    expect(html).toContain("<p>Visible paragraph</p>");
  });
});
