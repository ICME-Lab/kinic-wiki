// Where: shared browser link helpers.
// What: Build public database URLs and X share intents.
// Why: Keep share links encoded consistently and avoid static route collisions.

const X_TWEET_INTENT_URL = "https://twitter.com/intent/tweet";
const PUBLIC_WIKI_ORIGIN = "https://wiki.kinic.xyz";
const RESERVED_DATABASE_ROUTE_SLUGS = new Set(["_next", "api", "cli", "dashboard", "skills"]);

export function isReservedDatabaseRouteSlug(databaseId: string): boolean {
  return RESERVED_DATABASE_ROUTE_SLUGS.has(databaseId.trim().toLowerCase());
}

export function isRoutableDatabaseId(databaseId: string): boolean {
  return databaseId.trim().length > 0 && !isReservedDatabaseRouteSlug(databaseId);
}

export function publicDatabasePath(databaseId: string): string {
  assertPublicDatabaseId(databaseId);
  return `/${encodeURIComponent(databaseId)}/Wiki`;
}

export function publicDatabaseUrl(databaseId: string, origin = PUBLIC_WIKI_ORIGIN): string {
  return new URL(publicDatabasePath(databaseId), origin).toString();
}

export function xShareDatabaseHref({
  databaseId,
  databaseName,
  origin = PUBLIC_WIKI_ORIGIN
}: {
  databaseId: string;
  databaseName: string;
  origin?: string;
}): string {
  const intent = new URL(X_TWEET_INTENT_URL);
  intent.searchParams.set("text", `Kinic Wiki: ${databaseName}`);
  intent.searchParams.set("url", publicDatabaseUrl(databaseId, origin));
  return intent.toString();
}

function assertPublicDatabaseId(databaseId: string): void {
  if (!isRoutableDatabaseId(databaseId)) {
    throw new Error(`reserved database route slug: ${databaseId}`);
  }
}
