import { createFileRoute } from "@tanstack/react-router";
import IOSGuidePage from "@/app/docs/ios/page";
import { routeHead } from "@/lib/route-head";

const title = "KinicWiki iOS Setup Guide | Kinic Wiki";
const description = "Set up the KinicWiki Share Extension to save Safari pages and X posts under /Sources, review capture results, and retry from Capture history.";

export const Route = createFileRoute("/docs/ios")({
  head: () => ({
    ...routeHead(title, description),
    links: [{ rel: "canonical", href: "https://wiki.kinic.xyz/docs/ios" }]
  }),
  component: IOSGuidePage
});
