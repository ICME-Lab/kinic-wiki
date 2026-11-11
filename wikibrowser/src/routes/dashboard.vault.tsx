import { createFileRoute } from "@tanstack/react-router";
import VaultPage from "@/app/vault/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/dashboard/vault")({
  head: () => routeHead("Private Vault | Kinic Wiki", "Your private encrypted Vault workspace."),
  component: VaultPage
});
