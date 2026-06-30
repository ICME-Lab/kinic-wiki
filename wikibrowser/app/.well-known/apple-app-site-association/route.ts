// Where: wikibrowser/app/.well-known/apple-app-site-association/route.ts
// What: AASA document for KinicWikiApp Universal Links and webcredentials.
// Why: iOS Internet Identity callbacks and passkey association require the same canonical domain.

const BUNDLE_ID = "xyz.kinic.ios.KinicWiki";

export function GET(): Response {
  const appID = process.env.KINIC_IOS_APP_ID?.trim();
  if (!appID || !appID.endsWith(`.${BUNDLE_ID}`)) {
    return Response.json({ error: "KINIC_IOS_APP_ID is not configured" }, { status: 503 });
  }
  return Response.json(
    {
      applinks: {
        apps: [],
        details: [
          {
            appID,
            paths: ["/*"]
          }
        ]
      },
      webcredentials: {
        apps: [appID]
      }
    },
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    }
  );
}
