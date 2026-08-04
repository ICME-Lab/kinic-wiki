import { createFileRoute } from "@tanstack/react-router";
import ClipperPage from "@/app/docs/clipper/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/docs/clipper")({
  head: () => routeHead("Kinic Wiki Clipper", "Save ChatGPT and Claude conversations or active web pages into a Kinic Wiki database, and understand how Clipper and Dashboard sign-in work."),
  component: ClipperPage
});
