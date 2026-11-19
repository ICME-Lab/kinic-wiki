"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import { VaultReferenceCard } from "@/components/vault-reference-card";
import { WikiNavigationLink } from "@/components/wiki-navigation";
import { Markdown, type MarkdownComponents } from "@/lib/markdown-renderer";
import { safeMarkdownImageSrc } from "@/lib/markdown-images";
import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";
import { renderWikilinksAsMarkdown } from "@/lib/markdown-wikilinks";
import { hrefForMarkdownLink } from "@/lib/paths";
import { isVaultReferenceUrl, trustedVaultOrigin, vaultReferenceMarkdown } from "@/lib/vault-reference";

// Match the server's ordinary Markdown link on the first hydration render.
const subscribeToClient = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

const VaultParagraphContext = createContext<{
  articleKey: string;
  markdown: string;
  origin: string;
} | null>(null);

// A stable paragraph component keeps an open frame mounted during article rerenders.
const VaultAwareParagraph: NonNullable<MarkdownComponents["p"]> = ({ node, children, ...props }) => {
  const context = useContext(VaultParagraphContext);
  const link = node?.children[0];
  if (context && node?.children.length === 1 && link?.type === "element" && link.tagName === "a") {
    const { href } = link.properties;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    // Inspect the parsed paragraph first. Verify its source to rule out
    // normalized destinations, escaped syntax, titles and link definitions.
    if (isVaultReferenceUrl(href, context.origin) && start !== undefined && end !== undefined
      && context.markdown.slice(start, end) === vaultReferenceMarkdown(href)) {
      return <VaultReferenceCard key={JSON.stringify([context.articleKey, href])} href={href} />;
    }
  }
  return <p {...props}>{children}</p>;
};

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
  const isClient = useSyncExternalStore(subscribeToClient, clientSnapshot, serverSnapshot);
  const vaultOrigin = isClient ? trustedVaultOrigin(window.location.origin) : null;
  const frontmatter = splitMarkdownFrontmatter(content);
  const markdown = renderWikilinksAsMarkdown(frontmatter ? frontmatter.body : content);
  const vaultReferences = vaultOrigin ? {
    articleKey: JSON.stringify([canisterId, databaseId, nodePath]),
    // The parser's source offsets exclude a leading byte-order mark.
    markdown: markdown.replace(/^\uFEFF/, ""),
    origin: vaultOrigin
  } : null;
  return (
    <VaultParagraphContext.Provider value={vaultReferences}>
      {frontmatter ? <TrustBanner canisterId={canisterId} databaseId={databaseId} fields={frontmatter.fields} /> : null}
      {frontmatter && frontmatter.fields.length > 0 ? <FrontmatterSummary fields={frontmatter.fields} /> : null}
      <Markdown
        components={{
          p: VaultAwareParagraph,
          a({ href, children, node: _node, ...props }) {
            const wikiHref = hrefForMarkdownLink(canisterId, databaseId, nodePath, href);
            if (!wikiHref) {
              return <a href={href} {...props}>{children}</a>;
            }
            return <WikiNavigationLink href={wikiHref} {...props}>{children}</WikiNavigationLink>;
          },
          img({ src, alt, node: _node, ...props }) {
            const safeSrc = safeMarkdownImageSrc(src);
            if (!safeSrc) {
              return alt ? <span className="text-xs text-muted">{alt}</span> : null;
            }
            // Markdown image hosts are user-controlled, so a fixed host allowlist is not applicable here.
            return <img src={safeSrc} alt={alt ?? ""} {...props} />;
          }
        }}
      >
        {markdown}
      </Markdown>
    </VaultParagraphContext.Provider>
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
          <WikiNavigationLink className="text-accent no-underline hover:underline" href={hrefForMarkdownLink(canisterId, databaseId, "/Knowledge/index.md", storePath) ?? "#"}>
            {storePath}
          </WikiNavigationLink>
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
