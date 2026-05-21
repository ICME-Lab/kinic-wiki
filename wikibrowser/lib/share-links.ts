// Where: shared browser link helpers.
// What: Build public database URLs and X share intents.
// Why: Keep share links encoded consistently across dashboard surfaces.

const X_TWEET_INTENT_URL = "https://twitter.com/intent/tweet";
const PUBLIC_WIKI_ORIGIN = "https://wiki.kinic.xyz";

export function publicDatabasePath(databaseId: string): string {
  return `/${encodeURIComponent(databaseId)}/Wiki?read=anonymous`;
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
