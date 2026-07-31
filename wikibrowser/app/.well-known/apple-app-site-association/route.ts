// Where: wikibrowser/app/.well-known/apple-app-site-association/route.ts
// What: Serves the iOS Associated Domains document with an explicit JSON content type.
// Why: iOS rejects native auth HTTPS callbacks unless webcredentials/applinks are fetched as AASA.

export const appleAppSiteAssociation = {
  applinks: {
    apps: [],
    details: [
      {
        appID: "AKN976G7AK.xyz.kinic.ios.KinicWiki",
        paths: ["NOT /cycles", "NOT /cycles/*", "/*"]
      }
    ]
  },
  webcredentials: {
    apps: ["AKN976G7AK.xyz.kinic.ios.KinicWiki"]
  }
};

export function GET(): Response {
  return new Response(JSON.stringify(appleAppSiteAssociation, null, 2), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json"
    }
  });
}
