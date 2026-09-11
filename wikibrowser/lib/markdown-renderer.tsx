// Where: wikibrowser/lib/markdown-renderer.tsx
// What: Shared safe CommonMark/GFM renderer for WikiBrowser Markdown surfaces.
// Why: Keep rendering policy consistent without maintaining a local Markdown parser.
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export type MarkdownComponents = Components;

const safeUrlTransform: UrlTransform = (url) => defaultUrlTransform(url) || undefined;

export function Markdown({ children, components }: { children: string; components?: MarkdownComponents }) {
  return (
    <ReactMarkdown
      components={components}
      remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
      urlTransform={safeUrlTransform}
    >
      {children}
    </ReactMarkdown>
  );
}
