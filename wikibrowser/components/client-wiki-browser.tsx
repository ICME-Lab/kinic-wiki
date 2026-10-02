import { ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// SEO content is rendered by the child route. The interactive editor and its ICP
// SDK are needed only after hydration, so do not import or render them in SSR.
const WikiBrowser = lazy(() => import("./wiki-browser").then((module) => ({ default: module.WikiBrowser })));

export function ClientWikiBrowser() {
  const fallback = <output className="block min-h-screen bg-canvas" aria-label="Loading wiki" />;
  return <ClientOnly fallback={fallback}><Suspense fallback={fallback}><WikiBrowser /></Suspense></ClientOnly>;
}
