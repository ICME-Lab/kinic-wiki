// Where: wikibrowser/app/sitemap.ts
// What: Expose public discovery URLs for search engines.
// Why: Crawlers need explicit entry points before they can follow server-rendered wiki node links.

import type { MetadataRoute } from "next";
import { publicDatabasePath } from "@/lib/share-links";
import { listDatabasesPublic } from "@/lib/vfs-client";

const SITE_ORIGIN = "https://wiki.kinic.xyz";
const STATIC_PATHS = ["/", "/docs", "/docs/cli", "/docs/canister-api", "/docs/skills", "/marketplace"];

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticEntries = STATIC_PATHS.map((path) => sitemapEntry(path, now, "weekly"));
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  if (!canisterId) return staticEntries;
  try {
    const databases = await listDatabasesPublic(canisterId);
    const databaseEntries = databases
      .filter((database) => database.status === "active")
      .map((database) => sitemapEntry(publicDatabasePath(database.databaseId), now, "daily"));
    return [...staticEntries, ...databaseEntries];
  } catch {
    return staticEntries;
  }
}

function sitemapEntry(path: string, lastModified: Date, changeFrequency: "daily" | "weekly"): MetadataRoute.Sitemap[number] {
  return {
    url: new URL(path, SITE_ORIGIN).toString(),
    lastModified,
    changeFrequency,
    priority: path === "/" ? 1 : 0.7
  };
}
