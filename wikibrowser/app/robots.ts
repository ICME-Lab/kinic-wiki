// Where: wikibrowser/app/robots.ts
// What: Publish crawler access rules and sitemap location.
// Why: Search engines need an explicit robots policy for public Kinic Wiki pages.

import type { MetadataRoute } from "next";

const SITE_ORIGIN = "https://wiki.kinic.xyz";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/dashboard/", "/profile/", "/cycles/", "/metrics/"]
    },
    sitemap: new URL("/sitemap.xml", SITE_ORIGIN).toString()
  };
}
