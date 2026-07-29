import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeMarkdownImageSrc } from "@/lib/markdown-images";
import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";

export function PublicMarkdownPreview({ content }: { content: string }) {
  const frontmatter = splitMarkdownFrontmatter(content);
  const markdown = withoutLeadingHeading(plainWikilinks(frontmatter ? frontmatter.body : content));
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
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
    </ReactMarkdown>
  );
}

function withoutLeadingHeading(markdown: string): string {
  return markdown.replace(/^\s*#{1,6}\s+.+?\s*#*\s*(?:\n+|$)/, "");
}

function plainWikilinks(markdown: string): string {
  return markdown.replace(/!\[\[([^\]]+)\]\]/g, "$1").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label ?? target);
}

function isExternalHttpsUrl(href: string | undefined): boolean {
  if (!href) return false;
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}
