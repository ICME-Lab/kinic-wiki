// Where: wikibrowser/app/ios-auth-callback/route.ts
// What: Stable HTTPS callback path for iOS ASWebAuthenticationSession.
// Why: Universal Links need a real production path even though iOS consumes the URL before page rendering.

export function GET(): Response {
  return new Response("<!doctype html><title>KinicWikiApp</title><p>Return to KinicWikiApp.</p>", {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
