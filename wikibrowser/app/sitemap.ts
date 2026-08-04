// Where: wikibrowser/app/sitemap.ts
// What: Expose public discovery URLs for search engines.
// Why: Crawlers need explicit entry points before they can follow server-rendered wiki node links.

import { publicDatabasePath } from "@/lib/share-links";
import { listDatabasesPublic } from "@/lib/vfs-client";

const SITE_ORIGIN = "https://wiki.kinic.xyz";
const STATIC_PATHS = ["/", "/ios", "/docs", "/docs/clipper", "/docs/cli", "/docs/canister-api", "/docs/skills", "/marketplace", "/privacy-policy", "/support"];

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<SitemapEntry[]> {
  const now = new Date();
  const staticEntries = STATIC_PATHS.map((path) => sitemapEntry(path, now, "weekly"));
  const canisterId = import.meta.env.VITE_KINIC_WIKI_CANISTER_ID ?? "";
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

export type SitemapEntry = { url: string; lastModified: Date; changeFrequency: "daily" | "weekly"; priority: number };

function sitemapEntry(path: string, lastModified: Date, changeFrequency: "daily" | "weekly"): SitemapEntry {
  return {
    url: new URL(path, SITE_ORIGIN).toString(),
    lastModified,
    changeFrequency,
    priority: path === "/" ? 1 : 0.7
  };
}
