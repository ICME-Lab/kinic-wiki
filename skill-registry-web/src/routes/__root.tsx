import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import "@/app/globals.css";

const DESCRIPTION = "Inspect Kinic Skill Registry snapshots, run evidence, and permissions.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Kinic Skill Registry" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Kinic Skill Registry" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:site_name", content: "Kinic Skill Registry" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" }
    ]
  }),
  notFoundComponent: () => <main className="grid min-h-screen place-items-center p-6"><h1>Not found</h1></main>,
  component: RootDocument
});

function RootDocument() {
  return <html lang="en"><head><HeadContent /></head><body><Outlet /><Scripts /></body></html>;
}
