// @vitest-environment jsdom
import type { AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SupportPage from "@/app/support-page";
import PrivacyPolicyPage from "@/app/privacy-policy-page";
import { SkillMarkdownBlock } from "@/app/docs/skills/[slug]/skill-markdown-block";
import { MarkdownPreview } from "@/components/markdown-preview";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>
}));

describe("Markdown surfaces", () => {
  it.each([SupportPage, PrivacyPolicyPage])("preserves legal headings and external link attributes", (Page) => {
    const document = new DOMParser().parseFromString(renderToStaticMarkup(<Page />), "text/html");
    expect(document.querySelector("[node]")).toBeNull();
    const sections = [...document.querySelectorAll('a[href^="#"]')];
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) expect(document.getElementById(section.getAttribute("href")!.slice(1))).not.toBeNull();
    const links = [...document.querySelectorAll('article a[href^="https://"]')];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    }
  });

  it("preserves skill list numbering without parser attributes", () => {
    const document = new DOMParser().parseFromString(renderToStaticMarkup(<SkillMarkdownBlock markdown={"- item\n\n3. third\n4. fourth"} references={[]} />), "text/html");
    expect(document.querySelector("[node]")).toBeNull();
    expect(document.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(document.querySelector("ul li")?.textContent).toBe("item");
  });

  it("preserves client preview routes and image policy without parser attributes", () => {
    const html = renderToStaticMarkup(<MarkdownPreview canisterId="test" databaseId="db_alpha" nodePath="/Knowledge/guide/index.md" content={"[Next](next.md) ![Safe](https://example.com/x.png) ![Unsafe](http://example.com/x.png)"} />);
    expect(html).not.toContain(" node=");
    expect(html).toContain('href="/db/db_alpha/Knowledge/guide/next.md"');
    expect(html).toContain('src="https://example.com/x.png"');
    expect(html).not.toContain('src="http://example.com/x.png"');
    expect(html).toContain("Unsafe</span>");
  });
});
