// Where: wikibrowser/app/ios-share/route.ts
// What: Stable Universal Link target for Share Extension app handoff.
// Why: iOS should open KinicWikiApp directly without a custom-scheme browser confirmation.

export function GET(): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open KinicWikiApp</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 32px; color: #000; background: #fff; }
      main { max-width: 420px; margin: 20vh auto 0; }
      a { display: inline-block; margin-top: 20px; padding: 14px 18px; border-radius: 14px; background: #000; color: #fff; text-decoration: none; font-weight: 700; }
      p { color: #636161; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Open KinicWikiApp</h1>
      <p>If KinicWikiApp did not open automatically, open it here to send the shared URL.</p>
      <a href="kinicwiki://share">Open KinicWikiApp</a>
    </main>
  </body>
</html>`,
    {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
    }
  );
}
