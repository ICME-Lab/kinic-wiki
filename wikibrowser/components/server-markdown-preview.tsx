// Where: server-rendered WikiBrowser crawler content.
// What: Render public Markdown into static HTML with safe links and images.
// Why: Search crawlers need useful node content before the client browser fetches VFS data.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeMarkdownImageSrc } from "@/lib/markdown-images";
import { renderWikilinksAsMarkdown } from "@/lib/markdown-wikilinks";
import { hrefForMarkdownLink } from "@/lib/paths";

export function ServerMarkdownPreview({
  canisterId,
  databaseId,
  nodePath,
  content
}: {
  canisterId: string;
  databaseId: string;
  nodePath: string;
  content: string;
}) {
  const markdown = renderWikilinksAsMarkdown(content);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a({ href, children, ...props }) {
          const wikiHref = hrefForMarkdownLink(canisterId, databaseId, nodePath, href);
          if (!wikiHref) {
            return (
              <a href={href} {...props}>
                {children}
              </a>
            );
          }
          return (
            <a href={wikiHref} {...props}>
              {children}
            </a>
          );
        },
        img({ src, alt, ...props }) {
          const safeSrc = safeMarkdownImageSrc(src);
          if (!safeSrc) return alt ? <span>{alt}</span> : null;
          // Markdown image hosts are user-controlled, so a fixed host allowlist is not applicable here.
          return <img src={safeSrc} alt={alt ?? ""} {...props} />;
        }
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
