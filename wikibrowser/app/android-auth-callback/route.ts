// Where: wikibrowser/app/android-auth-callback/route.ts
// What: Stable HTTPS callback path for Android browser-based native auth.
// Why: Android App Links need a production path even though the app consumes the URL.

export function GET(): Response {
  return new Response("<!doctype html><title>KinicWikiApp</title><p>Return to KinicWikiApp.</p>", {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
