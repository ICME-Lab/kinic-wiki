import { createFileRoute } from "@tanstack/react-router";
import { AdminRouteShell } from "@/app/admin-route-shell";
import { VaultCreditClient } from "@/app/vault-credit/vault-credit-client";
export const Route = createFileRoute("/vault-credit")({
  head: () => ({
    meta: [
      { title: "Vault auto top-up" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <AdminRouteShell>
      <VaultCreditClient
        canisterId={import.meta.env.VITE_KINIC_WIKI_CANISTER_ID ?? ""}
      />
    </AdminRouteShell>
  ),
});
