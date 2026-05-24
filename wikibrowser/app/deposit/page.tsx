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
      amountE8s={first(params.amount_e8s ?? params.amountE8s)}
      canisterId={first(params.canister_id ?? params.canisterId) || process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""}
      databaseId={first(params.database_id ?? params.databaseId)}
    />
  );
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
