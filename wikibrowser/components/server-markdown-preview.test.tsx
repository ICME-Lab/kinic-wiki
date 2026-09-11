import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServerMarkdownPreview } from "@/components/server-markdown-preview";

function render(content: string): string {
  return renderToStaticMarkup(
    <ServerMarkdownPreview
      canisterId="t63gs-up777-77776-aaaba-cai"
      databaseId="db_alpha"
      nodePath="/Knowledge/guide/index.md"
      content={content}
    />
  );
}

describe("ServerMarkdownPreview", () => {
  it("routes relative wiki links and preserves safe external links", () => {
    const html = render("[Next](next.md) [External](https://example.com)");

    expect(html).toContain('href="/db/db_alpha/Knowledge/guide/next.md"');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain(" node=");
  });

  it("allows HTTPS images and replaces unsafe images with alt text", () => {
    const html = render("![Safe](https://example.com/image.png) ![Unsafe](http://example.com/image.png)");

    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).not.toContain('src="http://example.com/image.png"');
    expect(html).toContain("<span>Unsafe</span>");
    expect(html).not.toContain(" node=");
  });
});
