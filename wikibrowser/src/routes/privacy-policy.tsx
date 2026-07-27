import { createFileRoute } from "@tanstack/react-router";
import PrivacyPolicyPage from "@/app/privacy-policy-page";
import { routeHead } from "@/lib/route-head";

const title = "Privacy Policy | Kinic Wiki";
const description = "How Kinic processes, stores, protects, and retains information across Kinic Wiki and Ask AI.";

export const Route = createFileRoute("/privacy-policy")({
  head: () => ({
    ...routeHead(title, description),
    links: [{ rel: "canonical", href: "https://wiki.kinic.xyz/privacy-policy" }]
  }),
  component: PrivacyPolicyPage
});
