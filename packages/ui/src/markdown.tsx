// Where: packages/ui/src/markdown.tsx
// What: Shared safe CommonMark/GFM renderer with caller-owned content policy.
// Why: Keep rendering policy consistent without maintaining a local Markdown parser.
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type MarkdownComponents = Components;

const safeUrlTransform: UrlTransform = (url) => defaultUrlTransform(url) || undefined;
const gfmOptions = { singleTilde: false };
const markdownParser = unified().use(remarkParse).use(remarkGfm, gfmOptions);

export function unclosedTopLevelFenceOffset(markdown: string): number | undefined {
  if (!markdown.includes("```") && !markdown.includes("~~~")) return;
  // An unindented paragraph at EOF can only be part of a top-level code
  // block when an unclosed fence consumes it. Nested fences end with their container.
  const probe = `${markdown}\n\n.`;
  const last = markdownParser.parse(probe).children.at(-1);
  if (last?.type === "code" && last.value.endsWith("\n.")) {
    const offset = last.position?.start.offset;
    if (offset !== undefined) {
      return offset + (markdown.startsWith("\uFEFF") ? 1 : 0);
    }
  }
}

export function Markdown({ children, components, skipHtml = false }: { children: string; components?: MarkdownComponents; skipHtml?: boolean }) {
  return (
    <ReactMarkdown
      components={components}
      skipHtml={skipHtml}
      remarkPlugins={[[remarkGfm, gfmOptions]]}
      urlTransform={safeUrlTransform}
    >
      {children}
    </ReactMarkdown>
  );
}
