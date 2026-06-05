import type { Metadata } from "next";
import { MarketplaceClient } from "./marketplace-client";

export const metadata: Metadata = {
  title: "Kinic Marketplace",
  description: "Browse paid Kinic Wiki database access listings."
};

export default function MarketplacePage() {
  return <MarketplaceClient canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""} />;
}
