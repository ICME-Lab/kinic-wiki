import remarkWikiLink from "@flowershow/remark-wiki-link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeMarkdownImageSrc } from "@/lib/markdown-images";
import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";

export function PublicMarkdownPreview({ content }: { content: string }) {
  const frontmatter = splitMarkdownFrontmatter(content);
  const markdown = frontmatter ? frontmatter.body : content;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkWikiLink, remarkGfm, remarkPublicMarkdown]}
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

type MarkdownNode = {
  type: string;
  value?: string;
  data?: {
    alias?: string;
  };
  children?: MarkdownNode[];
};

function remarkPublicMarkdown() {
  return (tree: MarkdownNode) => {
    replaceWikilinksWithText(tree);
    if (tree.children?.[0]?.type === "heading") {
      tree.children.shift();
    }
  };
}

function replaceWikilinksWithText(node: MarkdownNode): void {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    if (child.type === "wikiLink" || child.type === "embed") {
      return {
        type: "text",
        value: child.type === "wikiLink" ? child.data?.alias ?? child.value ?? "" : child.value ?? ""
      };
    }
    replaceWikilinksWithText(child);
    return child;
  });
}

function isExternalHttpsUrl(href: string | undefined): boolean {
  if (!href) return false;
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}
