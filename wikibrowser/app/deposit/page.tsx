// Where: /deposit route.
// What: passes the configured canister and target database into the client.
// Why: amount is entered on the page, and canister selection must not come from URL input.
import type { Metadata } from "next";
import { DepositClient } from "./deposit-client";

export const metadata: Metadata = {
  title: "Kinic Wiki Deposit",
  description: "Fund a Kinic Wiki database billing balance with a wallet."
};

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DepositPage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  return (
    <DepositClient
      canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""}
      databaseId={first(params.database_id ?? params.databaseId)}
    />
  );
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
