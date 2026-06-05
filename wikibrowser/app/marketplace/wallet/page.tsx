import type { Metadata } from "next";
import { MarketWalletClient } from "./wallet-client";

export const metadata: Metadata = {
  title: "Kinic Market Wallet"
};

export default function MarketWalletPage() {
  return <MarketWalletClient canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""} />;
}
