import { Markdown } from "@/lib/markdown-renderer";
import { safeMarkdownImageSrc } from "@/lib/markdown-images";
import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";
import { renderWikilinksAsText } from "@/lib/markdown-wikilinks";

export function PublicMarkdownPreview({ content }: { content: string }) {
  const frontmatter = splitMarkdownFrontmatter(content);
  const markdown = stripLeadingHeading(renderWikilinksAsText(frontmatter ? frontmatter.body : content));
  return (
    <Markdown
      components={{
        a({ href, children }) {
          if (!isExternalHttpsUrl(href)) return <span>{children}</span>;
          return <a href={href} rel="noopener noreferrer">{children}</a>;
        },
        img({ src, alt, ...props }) {
          const safeSrc = safeMarkdownImageSrc(src);
          if (!safeSrc) return alt ? <span>{alt}</span> : null;
          return <img src={safeSrc} alt={alt ?? ""} {...props} />;
        }
      }}
    >
      {markdown}
    </Markdown>
  );
}

function stripLeadingHeading(content: string): string {
  const lines = content.split("\n");
  const first = lines[0] ?? "";
  const isAtxHeading = /^#{1,6}\s+/.test(first);
  const isSetextHeading = lines.length > 1 && /^=+\s*$/.test(lines[1] ?? "");
  if (!isAtxHeading && !isSetextHeading) return content;
  return lines.slice(isSetextHeading ? 2 : 1).join("\n").replace(/^\n+/, "");
}

function isExternalHttpsUrl(href: string | undefined): boolean {
  if (!href) return false;
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}
