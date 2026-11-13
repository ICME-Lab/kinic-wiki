// Where: packages/ui/src/markdown.tsx
// What: Shared safe CommonMark/GFM renderer with caller-owned content policy.
// Why: Keep rendering policy consistent without maintaining a local Markdown parser.
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export type MarkdownComponents = Components;

const safeUrlTransform: UrlTransform = (url) => defaultUrlTransform(url) || undefined;

export function Markdown({ children, components, skipHtml = false }: { children: string; components?: MarkdownComponents; skipHtml?: boolean }) {
  return (
    <ReactMarkdown
      components={components}
      skipHtml={skipHtml}
      remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
      urlTransform={safeUrlTransform}
    >
      {children}
    </ReactMarkdown>
  );
}
