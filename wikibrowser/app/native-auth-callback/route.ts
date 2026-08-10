// Where: wikibrowser/app/native-auth-callback/route.ts
// What: Stable HTTPS callback path for native ICRC-167 authentication.
// Why: iOS and Android use one callback contract while their operating systems dispatch the link.

export function GET(): Response {
  return new Response("<!doctype html><title>KinicWikiApp</title><p>Return to KinicWikiApp.</p>", {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
