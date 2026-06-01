// Where: /credits route.
// What: passes the configured canister and target database into the client.
// Why: CLI/query can seed credits, but canister selection must not come from URL input.
import type { Metadata } from "next";
import { CreditsClient } from "./credits-client";

export const metadata: Metadata = {
  title: "Kinic Wiki Credits",
  description: "Fund a Kinic Wiki database credits balance with a wallet."
};

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CreditsPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  return (
    <CreditsClient
      canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""}
      databaseId={first(params.database_id ?? params.databaseId)}
      initialCredits={first(params.credits)}
    />
  );
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
