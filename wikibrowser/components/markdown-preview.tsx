"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";
import { renderWikilinksAsMarkdown } from "@/lib/markdown-wikilinks";
import { hrefForMarkdownLink } from "@/lib/paths";

export function MarkdownPreview({
  canisterId,
  databaseId,
  nodePath,
  content,
  readMode = null
}: {
  canisterId: string;
  databaseId: string;
  nodePath: string;
  content: string;
  readMode?: "anonymous" | null;
}) {
  const frontmatter = splitMarkdownFrontmatter(content);
  const markdown = renderWikilinksAsMarkdown(frontmatter ? frontmatter.body : content);
  return (
    <>
      {frontmatter && frontmatter.fields.length > 0 ? <FrontmatterSummary fields={frontmatter.fields} /> : null}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...props }) {
            const wikiHref = hrefForMarkdownLink(canisterId, databaseId, nodePath, href, readMode);
            if (!wikiHref) {
              return <a href={href} {...props}>{children}</a>;
            }
            return <Link href={wikiHref} {...props}>{children}</Link>;
          }
        }}
      >
        {markdown}
      </ReactMarkdown>
    </>
  );
}

function FrontmatterSummary({ fields }: { fields: { key: string; value: string }[] }) {
  const title = valueFor(fields, "metadata.title") ?? valueFor(fields, "title") ?? valueFor(fields, "name") ?? valueFor(fields, "id");
  const description = valueFor(fields, "description") ?? valueFor(fields, "summary");
  const chips = [
    valueFor(fields, "metadata.category"),
    valueFor(fields, "status"),
    valueFor(fields, "license")
  ].filter((value): value is string => Boolean(value));
  if (title || description || chips.length > 0) {
    return (
      <section className="mb-7 border-b border-line pb-5">
        {title ? <p className="text-sm font-semibold text-ink">{title}</p> : null}
        {description ? <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{description}</p> : null}
        {chips.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {chips.map((chip) => (
              <span key={chip} className="rounded-md border border-line bg-paper px-2 py-1 text-xs text-muted">{chip}</span>
            ))}
          </div>
        ) : null}
      </section>
    );
  }
  const visible = fields.slice(0, 6);
  return (
    <section className="mb-6 rounded-lg border border-line bg-paper px-4 py-3 text-sm">
      <div className="grid gap-3 md:grid-cols-2">
        {visible.map((field) => (
          <div key={field.key} className={field.key === "description" || field.key === "summary" ? "md:col-span-2" : ""}>
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{field.key}</p>
            <p className="mt-1 break-words text-ink">{field.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function valueFor(fields: { key: string; value: string }[], key: string): string | null {
  return fields.find((field) => field.key === key)?.value ?? null;
}
