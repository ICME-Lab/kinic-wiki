// Where: shared browser link helpers.
// What: Build public database URLs and X share intents.
// Why: Keep database ids under /db so app routes never compete with database slugs.

const X_TWEET_INTENT_URL = "https://twitter.com/intent/tweet";
const PUBLIC_WIKI_ORIGIN = "https://wiki.kinic.xyz";
const PUBLIC_DATABASE_ROUTE_PREFIX = "/db";

export function isRoutableDatabaseId(databaseId: string): boolean {
  return databaseId.trim().length > 0;
}

export function publicDatabasePath(databaseId: string): string {
  assertPublicDatabaseId(databaseId);
  return `${databaseRouteBase(databaseId)}/Knowledge`;
}

export function databaseRouteBase(databaseId: string): string {
  assertPublicDatabaseId(databaseId);
  return `${PUBLIC_DATABASE_ROUTE_PREFIX}/${encodeURIComponent(databaseId)}`;
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
    throw new Error(`invalid database id: ${databaseId}`);
  }
}
