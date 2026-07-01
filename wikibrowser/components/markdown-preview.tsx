"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeMarkdownImageSrc } from "@/lib/markdown-images";
import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";
import { renderWikilinksAsMarkdown } from "@/lib/markdown-wikilinks";
import { hrefForMarkdownLink } from "@/lib/paths";

export function MarkdownPreview({
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
  const frontmatter = splitMarkdownFrontmatter(content);
  const markdown = renderWikilinksAsMarkdown(frontmatter ? frontmatter.body : content);
  return (
    <>
      {frontmatter ? <TrustBanner canisterId={canisterId} databaseId={databaseId} fields={frontmatter.fields} /> : null}
      {frontmatter && frontmatter.fields.length > 0 ? <FrontmatterSummary fields={frontmatter.fields} /> : null}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...props }) {
            const wikiHref = hrefForMarkdownLink(canisterId, databaseId, nodePath, href);
            if (!wikiHref) {
              return <a href={href} {...props}>{children}</a>;
            }
            return <Link href={wikiHref} {...props}>{children}</Link>;
          },
          img({ src, alt, ...props }) {
            const safeSrc = safeMarkdownImageSrc(src);
            if (!safeSrc) {
              return alt ? <span className="text-xs text-muted">{alt}</span> : null;
            }
            return <img src={safeSrc} alt={alt ?? ""} {...props} />;
          }
        }}
      >
        {markdown}
      </ReactMarkdown>
    </>
  );
}

function TrustBanner({
  canisterId,
  databaseId,
  fields
}: {
  canisterId: string;
  databaseId: string;
  fields: { key: string; value: string }[];
}) {
  const status = valueFor(fields, "status");
  const storePath = valueFor(fields, "source_path") ?? valueFor(fields, "kinic.source_path") ?? valueFor(fields, "kinic.store_path");
  const canonicalizedBy = valueFor(fields, "canonicalized_by");
  const canonicalizedAt = valueFor(fields, "canonicalized_at");
  if (!status && !storePath && !canonicalizedBy && !canonicalizedAt) return null;
  const tone = status === "canonical" ? "green" : status === "archived" ? "muted" : "yellow";
  return (
    <section className={`mb-5 rounded-lg border px-4 py-3 text-sm ${tone === "green" ? "border-green-200 bg-green-50 text-green-950" : tone === "yellow" ? "border-yellow-200 bg-yellow-50 text-yellow-950" : "border-line bg-paper text-ink"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {status ? <span className="rounded border border-current/20 bg-white/60 px-2 py-1 font-mono text-[11px] uppercase">{status}</span> : null}
        {canonicalizedBy ? <span className="rounded border border-current/20 bg-white/60 px-2 py-1 font-mono text-[11px]">canonicalized_by {canonicalizedBy}</span> : null}
        {canonicalizedAt ? <span className="rounded border border-current/20 bg-white/60 px-2 py-1 font-mono text-[11px]">canonicalized_at {canonicalizedAt}</span> : null}
      </div>
      {storePath ? (
        <p className="mt-2 truncate font-mono text-xs">
          store{" "}
          <Link className="text-accent no-underline hover:underline" href={hrefForMarkdownLink(canisterId, databaseId, "/Knowledge/index.md", storePath) ?? "#"}>
            {storePath}
          </Link>
        </p>
      ) : null}
    </section>
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
