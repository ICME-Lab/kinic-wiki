import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/app/globals.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Kinic Wiki AI Memory" },
      { name: "description", content: "Use Kinic Wiki as canister-backed AI memory through kinic-vfs-cli, with browser tools for browsing and management." },
      { property: "og:title", content: "Kinic Wiki AI Memory" },
      { property: "og:description", content: "Use Kinic Wiki as canister-backed AI memory through kinic-vfs-cli, with browser tools for browsing and management." },
      { property: "og:site_name", content: "Kinic Wiki" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" }
    ],
    links: [{ rel: "icon", href: "/kinic-mark.png" }]
  }),
  notFoundComponent: NotFound,
  component: RootDocument
});

function RootDocument() {
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        <TooltipProvider delayDuration={120}>
          <div className="flex min-h-screen flex-col"><Outlet /></div>
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
        <HydrationSignal />
        <Scripts />
      </body>
    </html>
  );
}

function HydrationSignal() {
  useEffect(() => {
    // Passive effects run after hydration commits, when React event handlers are attached.
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return null;
}

function NotFound() {
  return <main className="grid min-h-screen place-items-center p-6"><section><h1>Not found</h1><a href="/">Return home</a></section></main>;
}
