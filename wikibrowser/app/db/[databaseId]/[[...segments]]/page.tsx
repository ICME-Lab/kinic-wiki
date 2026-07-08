// Where: wikibrowser/app/db/[databaseId]/[[...segments]]/page.tsx
// What: Server-render public wiki node content and page-level metadata.
// Why: Crawlers and OGP consumers cannot see VFS content fetched only by the client WikiBrowser shell.

import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { ServerMarkdownPreview } from "@/components/server-markdown-preview";
import { folderIndexPath, visibleChildren } from "@/lib/folder-index";
import { canonicalDatabaseId, hrefForPath } from "@/lib/paths";
import { databaseRouteBase } from "@/lib/share-links";
import type { ChildNode, DatabaseSummary, WikiNode } from "@/lib/types";
import { listChildren, listDatabasesPublic, readNode } from "@/lib/vfs-client";
import { wikiSeoDescription, wikiSeoNodeSummary, wikiSeoRouteFromSegments, wikiSeoTitle } from "@/lib/wiki-seo";

type WikiDatabasePageProps = {
  params: Promise<{
    databaseId: string;
    segments?: string[];
  }>;
};

type PublicNodePayload = {
  database: DatabaseSummary | null;
  node: WikiNode | null;
  folderIndexNode: WikiNode | null;
  children: ChildNode[];
};

export const revalidate = 86_400;

export async function generateMetadata({ params }: WikiDatabasePageProps): Promise<Metadata> {
  const { databaseId, segments } = await params;
  const canonicalId = canonicalDatabaseId(databaseId);
  const route = wikiSeoRouteFromSegments(segments);
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const payload = route.indexable ? await loadPublicNodePayload(canisterId, canonicalId, route.nodePath) : emptyPublicNodePayload(null);
  const databaseTitle = payload.database?.metadata.name.trim() || canonicalId;
  const metadataNode = payload.folderIndexNode ?? payload.node;
  const title = route.indexable ? wikiSeoTitle(databaseTitle, route.nodePath, metadataNode) : `Kinic Wiki: ${databaseTitle}`;
  const description = route.indexable ? wikiSeoDescription(payload.database, metadataNode, payload.children) : "Use the Kinic Wiki browser tools for search, graph, and help views.";
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
  const canonicalId = canonicalDatabaseId(databaseId);
  const route = wikiSeoRouteFromSegments(segments);
  if (!route.indexable) return null;
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const payload = await loadPublicNodePayload(canisterId, canonicalId, route.nodePath);
  const renderNode = payload.folderIndexNode ?? payload.node;
  if (!payload.database && !renderNode && payload.children.length === 0) return null;
  const summary = wikiSeoNodeSummary(payload.database, route.nodePath, renderNode, payload.children);
  return (
    <article className="wiki-seo-document markdown-body bg-canvas px-6 py-8 text-ink">
      <header className="mx-auto max-w-3xl border-b border-line pb-6">
        <p className="mb-2 font-mono text-xs text-muted">{route.nodePath}</p>
        <h1>{summary.title}</h1>
        <p className="mt-3 text-base leading-7 text-muted">{summary.description}</p>
      </header>
      <div className="mx-auto max-w-3xl">
        {renderNode ? (
          <ServerMarkdownPreview canisterId={canisterId} databaseId={canonicalId} nodePath={renderNode.path} content={summary.markdown} />
        ) : null}
        {payload.children.length > 0 ? (
          <nav aria-label="Folder contents" className="mt-8 border-t border-line pt-6">
            <h2>Folder contents</h2>
            <ul>
              {payload.children.map((child) => (
                <li key={child.path}>
                  <Link href={hrefForPath(canisterId, canonicalId, child.path)}>{child.name}</Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>
    </article>
  );
}

const loadPublicNodePayload = cache(async function loadPublicNodePayload(canisterId: string, databaseId: string, nodePath: string): Promise<PublicNodePayload> {
  if (!canisterId) return emptyPublicNodePayload(null);
  const [database, node] = await Promise.all([loadPublicDatabase(canisterId, databaseId), loadPublicNode(canisterId, databaseId, nodePath)]);
  const childPath = node?.kind === "folder" || !node ? nodePath : "";
  const [folderIndexNode, children] = childPath ? await Promise.all([
    loadPublicNode(canisterId, databaseId, folderIndexPath(childPath)),
    loadVisibleChildren(canisterId, databaseId, childPath)
  ]) : [null, []];
  return {
    database,
    node,
    folderIndexNode,
    children
  };
});

const loadPublicDatabase = cache(async function loadPublicDatabase(canisterId: string, databaseId: string): Promise<DatabaseSummary | null> {
  try {
    return (await listDatabasesPublic(canisterId)).find((database) => database.databaseId === databaseId) ?? null;
  } catch {
    return null;
  }
});

const loadPublicNode = cache(async function loadPublicNode(canisterId: string, databaseId: string, nodePath: string): Promise<WikiNode | null> {
  try {
    return await readNode(canisterId, databaseId, nodePath);
  } catch {
    return null;
  }
});

const loadVisibleChildren = cache(async function loadVisibleChildren(canisterId: string, databaseId: string, nodePath: string): Promise<ChildNode[]> {
  try {
    return visibleChildren(await listChildren(canisterId, databaseId, nodePath), nodePath);
  } catch {
    return [];
  }
});

function emptyPublicNodePayload(database: DatabaseSummary | null): PublicNodePayload {
  return {
    database,
    node: null,
    folderIndexNode: null,
    children: []
  };
}
