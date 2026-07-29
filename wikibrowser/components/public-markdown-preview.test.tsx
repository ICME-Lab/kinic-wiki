import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicMarkdownPreview } from "@/components/public-markdown-preview";

function render(content: string): string {
  return renderToStaticMarkup(<PublicMarkdownPreview content={content} />);
}

describe("PublicMarkdownPreview", () => {
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
    expect(html).toContain("<p>https://example.com</p>");
    expect(html).toContain("<p># Visible text</p>");
    expect(html).toContain("<p>- list item</p>");
    expect(html).toContain("<p>image.png</p>");
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

  it("removes only a leading Markdown heading", () => {
    const html = render("# Hidden title\n\nVisible paragraph\n\n## Visible subheading");

    expect(html).not.toContain("Hidden title");
    expect(html).toContain("<p>Visible paragraph</p>");
    expect(html).toContain("<h2>Visible subheading</h2>");
  });
});
