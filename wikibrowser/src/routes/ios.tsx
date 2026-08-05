import { createFileRoute } from "@tanstack/react-router";
import IOSPage from "@/app/ios-page";
import { routeHead } from "@/lib/route-head";

const title = "KinicWiki for iPhone and iPad | Kinic Wiki";
const description = "Save pages from Safari, browse your AI memory, and ask questions with visible source notes in the KinicWiki iOS app.";

export const Route = createFileRoute("/ios")({
  head: () => ({
    ...routeHead(title, description),
    links: [{ rel: "canonical", href: "https://wiki.kinic.xyz/ios" }]
  }),
  component: IOSPage
});
