import { createFileRoute } from "@tanstack/react-router";
import IOSGuidePage from "@/app/docs/ios/page";
import { routeHead } from "@/lib/route-head";

const title = "KinicWiki iOS Setup Guide | Kinic Wiki";
const description = "Install KinicWiki on iPhone or iPad, sign in, save Safari pages, browse your database, and ask questions with cited notes.";

export const Route = createFileRoute("/docs/ios")({
  head: () => ({
    ...routeHead(title, description),
    links: [{ rel: "canonical", href: "https://wiki.kinic.xyz/docs/ios" }]
  }),
  component: IOSGuidePage
});
