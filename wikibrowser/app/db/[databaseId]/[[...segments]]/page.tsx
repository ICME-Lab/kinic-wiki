// Where: wikibrowser/app/db/[databaseId]/[[...segments]]/page.tsx
// What: Server-render public wiki node content and page-level metadata.
// Why: Crawlers and OGP consumers cannot see VFS content fetched only by the client WikiBrowser shell.

import { canonicalDatabaseId, hrefForPath } from "@/lib/paths";
import { databaseRouteBase } from "@/lib/share-links";
import type { ChildNode } from "@/lib/types";
import { fetchPublicSeoPayload } from "@/lib/public-seo-http";
import { wikiSeoNodeSummary, wikiSeoRouteFromSegments, type WikiSeoNodeSummary } from "@/lib/wiki-seo";

type WikiDatabasePageProps = {
  params: Promise<{
    databaseId: string;
    segments?: string[];
  }>;
};

const MAX_SEO_CHILDREN = 100;

export async function generateMetadata({ params }: WikiDatabasePageProps): Promise<Record<string, unknown>> {
  const { databaseId, segments } = await params;
  const data = await loadWikiDatabasePageData(databaseId, segments);
  const { canisterId, databaseId: canonicalId, route, summary } = data;
  const { title, description } = summary;
  const canonical = route.indexable ? hrefForPath(canisterId, canonicalId, route.nodePath) : databaseRouteBase(canonicalId);
  const imageBase = databaseRouteBase(canonicalId);
  const imageAlt = `${title} link preview`;
  return {
    title,
    description,
    alternates: {
      canonical
    },
    robots: route.indexable ? undefined : {
      index: false,
      follow: true
    },
    openGraph: {
      title,
      description,
      siteName: "Kinic Wiki",
      type: "article",
      url: canonical,
      images: [
        {
          url: `${imageBase}/opengraph-image`,
          width: 1200,
          height: 630,
          alt: imageAlt
        }
      ]
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [
        {
          url: `${imageBase}/twitter-image`,
          alt: imageAlt
        }
      ]
    }
  };
}

export default async function WikiDatabasePage({ params }: WikiDatabasePageProps) {
  const { databaseId, segments } = await params;
  const data = await loadWikiDatabasePageData(databaseId, segments);
  return <WikiDatabaseDocument data={data} />;
}

export type WikiDatabasePageData = {
  canisterId: string;
  databaseId: string;
  route: ReturnType<typeof wikiSeoRouteFromSegments>;
  summary: WikiSeoNodeSummary;
  hasContent: boolean;
  children: Pick<ChildNode, "path" | "name">[];
  childrenTruncated: boolean;
};

export async function loadWikiDatabasePageData(databaseId: string, segments?: string[]): Promise<WikiDatabasePageData> {
  const canonicalId = canonicalDatabaseId(databaseId);
  const route = wikiSeoRouteFromSegments(segments);
  const canisterId = import.meta.env.VITE_KINIC_WIKI_CANISTER_ID ?? "";
  const payload = route.indexable ? await fetchPublicSeoPayload(canisterId, canonicalId, route.nodePath) : null;
  const renderNode = payload?.node ?? null;
  const summary = route.indexable
    ? wikiSeoNodeSummary(payload?.database ?? null, route.nodePath, renderNode, payload?.children ?? [], canonicalId)
    : { title: `Kinic Wiki: ${canonicalId}`, description: "Use the Kinic Wiki browser tools for search, graph, and help views.", textExcerpt: "" };
  // Serialize only the excerpt and visible links, never the complete VFS document.
  return {
    canisterId, databaseId: canonicalId, route, summary,
    hasContent: payload?.hasContent ?? false,
    children: (payload?.children ?? []).slice(0, MAX_SEO_CHILDREN).map(({ path, name }) => ({ path, name })),
    childrenTruncated: payload?.childrenTruncated ?? false
  };
}

export function WikiDatabaseDocument({ data }: { data: WikiDatabasePageData }) {
  const { canisterId, databaseId: canonicalId, route, summary, children, childrenTruncated } = data;
  if (!route.indexable || !data.hasContent) return null;
  return (
    <article className="wiki-seo-document markdown-body bg-canvas px-6 py-8 text-ink">
      <header className="mx-auto max-w-3xl border-b border-line pb-6">
        <p className="mb-2 font-mono text-xs text-muted">{route.nodePath}</p>
        <h1>{summary.title}</h1>
        <p className="mt-3 text-base leading-7 text-muted">{summary.description}</p>
      </header>
      <div className="mx-auto max-w-3xl">
        {summary.textExcerpt ? <p className="whitespace-pre-wrap break-words">{summary.textExcerpt}</p> : null}
        {children.length > 0 ? (
          <nav aria-label="Folder contents" className="mt-8 border-t border-line pt-6">
            <h2>Folder contents</h2>
            <ul>
              {children.map((child) => (
                <li key={child.path}>
                  <a href={hrefForPath(canisterId, canonicalId, child.path)}>{child.name}</a>
                </li>
              ))}
            </ul>
            {childrenTruncated ? <p>Showing the first {children.length} entries. Open this folder in the Wiki browser to see all entries.</p> : null}
          </nav>
        ) : null}
      </div>
    </article>
  );
}

export function wikiDatabaseHead(data: WikiDatabasePageData) {
  const { canisterId, databaseId, route, summary } = data;
  const { title, description } = summary;
  const canonical = route.indexable ? hrefForPath(canisterId, databaseId, route.nodePath) : databaseRouteBase(databaseId);
  const image = `${databaseRouteBase(databaseId)}/opengraph-image`;
  return {
    meta: [
      { title },
      { name: "description", content: description },
      ...(!route.indexable ? [{ name: "robots", content: "noindex,follow" }] : []),
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "article" },
      { property: "og:url", content: canonical },
      { property: "og:image", content: image },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: `${databaseRouteBase(databaseId)}/twitter-image` }
    ],
    links: [{ rel: "canonical", href: canonical }]
  };
}
