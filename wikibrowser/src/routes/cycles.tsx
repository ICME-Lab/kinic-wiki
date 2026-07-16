import { createFileRoute } from "@tanstack/react-router";
import type { DatabaseStatus } from "@/lib/types";
import { AdminRouteShell } from "@/app/admin-route-shell";
import { CyclesClient } from "@/app/cycles/cycles-client";
import { routeHead } from "@/lib/route-head";

type CyclesSearch = { database_id?: string; databaseId?: string; status?: DatabaseStatus };

export const Route = createFileRoute("/cycles")({
  head: () => routeHead("Kinic Wiki Cycles", "Fund a Kinic Wiki database cycles balance with a wallet."),
  validateSearch: (search: Record<string, unknown>): CyclesSearch => ({
    database_id: stringValue(search.database_id),
    databaseId: stringValue(search.databaseId),
    status: search.status === "pending" || search.status === "active" ? search.status : undefined
  }),
  component: CyclesRoute
});

function CyclesRoute() {
  const search = Route.useSearch();
  return <AdminRouteShell><CyclesClient canisterId={import.meta.env.VITE_KINIC_WIKI_CANISTER_ID ?? ""} databaseId={search.database_id ?? search.databaseId ?? ""} databaseStatus={search.status ?? null} /></AdminRouteShell>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
