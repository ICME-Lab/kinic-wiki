// Where: wikibrowser/app/db/[databaseId]/layout.tsx
// What: Persistent database browser shell for every node path in one database.
// Why: App Router pages are route leaves; keeping WikiBrowser in a layout preserves Explorer state across child navigation.

import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { WikiBrowser } from "@/components/wiki-browser";
import { databasePreviewDescription, databasePreviewTitle, loadDatabasePreview } from "@/lib/database-preview";
import { databaseRouteBase, publicDatabasePath } from "@/lib/share-links";

type WikiDatabaseLayoutProps = {
  children: ReactNode;
  params: Promise<{ databaseId: string }>;
};

export async function generateMetadata({ params }: { params: Promise<{ databaseId: string }> }): Promise<Metadata> {
  const { databaseId } = await params;
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const preview = await loadDatabasePreview(canisterId, databaseId);
  const title = databasePreviewTitle(preview.databaseTitle);
  const description = databasePreviewDescription(preview);
  const url = publicDatabasePath(preview.databaseId);
  const routeBase = databaseRouteBase(preview.databaseId);
  const imageAlt = `${title} link preview`;
  return {
    title,
    description,
    alternates: {
      canonical: url
    },
    openGraph: {
      title,
      description,
      siteName: "Kinic Wiki",
      type: "website",
      url,
      images: [
        {
          url: `${routeBase}/opengraph-image`,
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
          url: `${routeBase}/twitter-image`,
          alt: imageAlt
        }
      ]
    }
  };
}

export default async function WikiDatabaseLayout({ children, params }: WikiDatabaseLayoutProps) {
  void children;
  void params;
  return (
    <Suspense fallback={<div className="min-h-screen bg-canvas" />}>
      <WikiBrowser />
    </Suspense>
  );
}
