import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Suspense } from "react";
import { WikiBrowser } from "@/components/wiki-browser";

export const Route = createFileRoute("/db/$databaseId")({
  component: () => <><div className="wiki-seo-region"><Outlet /></div><Suspense fallback={<div className="min-h-screen bg-canvas" />}><WikiBrowser /></Suspense></>
});
