import { PublicMarkdownPreview } from "@/components/public-markdown-preview";
import { AppLink as Link } from "@/components/app-link";
import { publicNodePath } from "@/lib/share-links";
import type { PublicNode } from "@/lib/types";
import { readPublicNode } from "@/lib/vfs-client";

export type PublicNodePageData = {
  node: PublicNode | null;
  title: string;
  description: string;
};

export async function loadPublicNodePageData(publicId: string): Promise<PublicNodePageData> {
  if (!/^[0-9a-f]{32}$/.test(publicId)) return emptyPageData();
  const canisterId = import.meta.env.VITE_KINIC_WIKI_CANISTER_ID ?? "";
  if (!canisterId) throw new Error("VITE_KINIC_WIKI_CANISTER_ID is required to load public nodes");
  const node = await readPublicNode(canisterId, publicId);
  if (!node) return emptyPageData();
  return {
    node,
    title: publicNodeTitle(node.content),
    description: publicNodeDescription(node.content)
  };
}

export function publicNodeHead(publicId: string, data: PublicNodePageData) {
  if (!data.node) return { meta: [{ title: "Not found | Kinic Wiki" }, { name: "robots", content: "noindex" }] };
  const canonical = publicNodePath(publicId);
  return {
    meta: [
      { title: `${data.title} | Kinic Wiki` },
      { name: "description", content: data.description },
      { property: "og:title", content: data.title },
      { property: "og:description", content: data.description },
      { property: "og:type", content: "article" },
      { property: "og:url", content: canonical },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: data.title },
      { name: "twitter:description", content: data.description }
    ],
    links: [{ rel: "canonical", href: canonical }]
  };
}

export function PublicNodeDocument({ data }: { data: PublicNodePageData }) {
  if (!data.node) return null;
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-line bg-paper px-4 py-4 sm:px-6">
        <nav className="mx-auto flex max-w-[1080px] flex-wrap items-center justify-between gap-3" aria-label="Primary navigation">
          <Link
            aria-label="Kinic Wiki home"
            className="flex items-center gap-3 text-sm font-semibold text-ink no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            href="/"
          >
            <img className="h-9 w-9 rounded-lg" src="/kinic-mark.png" alt="" width={36} height={36} />
            <span>Kinic Wiki</span>
          </Link>
          <Link
            className="whitespace-nowrap rounded-lg border border-action bg-action px-3 py-2 text-sm font-semibold text-white no-underline hover:border-accent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            href="/dashboard"
          >
            Start using Kinic Wiki
          </Link>
        </nav>
      </header>

      <main className="px-4 py-8 sm:px-6 sm:py-14">
        <article className="wiki-seo-document markdown-body relative mx-auto max-w-3xl overflow-hidden rounded-2xl border border-line bg-white px-6 py-8 shadow-sm sm:px-10 sm:py-12">
          <div aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-accent" />
          <header className="mb-9 border-b border-line pb-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Published with Kinic Wiki</p>
            <h1 className="mt-3">{data.title}</h1>
            <p className="mt-3 text-sm text-muted">
              Updated {formatTimestamp(data.node.updatedAt)} · Published {formatTimestamp(data.node.publishedAtMs)}
            </p>
          </header>
          <PublicMarkdownPreview content={data.node.content} />
        </article>

        <section className="relative mx-auto mt-6 max-w-3xl overflow-hidden rounded-2xl border border-line bg-paper px-6 py-6 sm:flex sm:items-center sm:justify-between sm:gap-8 sm:px-10">
          <div aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-accent" />
          <div>
            <h2 className="text-xl font-semibold leading-tight text-ink">Build your own AI memory with Kinic Wiki</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted">Turn sources into durable, linked knowledge that agents can search, cite, and maintain.</p>
          </div>
          <Link
            className="mt-5 inline-flex shrink-0 whitespace-nowrap rounded-lg border border-action bg-action px-4 py-2.5 text-sm font-semibold text-white no-underline hover:border-accent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 sm:mt-0"
            href="/dashboard"
          >
            Start using Kinic Wiki
          </Link>
        </section>
      </main>
    </div>
  );
}

function publicNodeTitle(content: string): string {
  const body = splitFrontmatterText(content);
  const heading = body.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1];
  return cleanInlineMarkdown(heading ?? "Published note").slice(0, 120);
}

function publicNodeDescription(content: string): string {
  const body = splitFrontmatterText(content);
  const paragraph = body
    .split(/\n\s*\n/)
    .map((value) => value.replace(/\n/g, " ").trim())
    .find((value) => value && !/^(#{1,6}\s|```|~~~|[-*+]\s|>\s)/.test(value));
  return cleanInlineMarkdown(paragraph ?? "A note published with Kinic Wiki").slice(0, 180);
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label ?? target)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitFrontmatterText(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  return end === -1 ? content : content.slice(end + 4);
}

function formatTimestamp(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString("en", { dateStyle: "medium" }) : value;
}

function emptyPageData(): PublicNodePageData {
  return { node: null, title: "Not found", description: "This published note is not available." };
}
