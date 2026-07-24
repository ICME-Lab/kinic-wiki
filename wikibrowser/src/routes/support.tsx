import { createFileRoute } from "@tanstack/react-router";
import SupportPage from "@/app/support-page";
import { routeHead } from "@/lib/route-head";

const title = "Support | Kinic Wiki";
const description = "Get help with Kinic Wiki and the Kinic Wiki ChatGPT app.";

export const Route = createFileRoute("/support")({
  head: () => ({
    ...routeHead(title, description),
    links: [{ rel: "canonical", href: "https://wiki.kinic.xyz/support" }]
  }),
  component: SupportPage
});
