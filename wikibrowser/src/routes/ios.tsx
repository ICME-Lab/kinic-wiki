import { createFileRoute } from "@tanstack/react-router";
import IOSPage from "@/app/ios-page";
import { routeHead } from "@/lib/route-head";

const title = "KinicWiki for iPhone and iPad | Kinic Wiki";
const description = "Use the KinicWiki Share Extension to save Safari pages and X posts under /Sources, then browse and ask questions with the source notes attached.";

export const Route = createFileRoute("/ios")({
  head: () => ({
    ...routeHead(title, description),
    links: [{ rel: "canonical", href: "https://wiki.kinic.xyz/ios" }]
  }),
  component: IOSPage
});
