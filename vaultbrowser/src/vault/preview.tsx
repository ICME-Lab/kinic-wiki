import { Markdown, type MarkdownComponents } from "@kinic/vault-ui/markdown";
const privateComponents: MarkdownComponents = {
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image omitted]"}</span>,
  a: ({ children }) => <span>{children}</span>,
};
export function VaultPreview({ content }: { content: string }) {
  return (
    <div className="prose min-w-0 break-words text-sm [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto">
      <Markdown components={privateComponents} skipHtml>
        {content}
      </Markdown>
    </div>
  );
}
