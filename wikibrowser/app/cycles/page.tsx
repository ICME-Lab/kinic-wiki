// Where: /cycles route.
// What: passes the configured canister and target database into the client.
// Why: CLI/query can seed cycles, but canister selection must not come from URL input.
import type { Metadata } from "next";
import { CyclesClient } from "./cycles-client";

export const metadata: Metadata = {
  title: "Kinic Wiki Cycles",
  description: "Fund a Kinic Wiki database cycles balance with a wallet."
};

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CyclesPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  return (
    <CyclesClient
      canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""}
      databaseId={first(params.database_id ?? params.databaseId)}
      initialKinic={first(params.kinic)}
    />
  );
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
