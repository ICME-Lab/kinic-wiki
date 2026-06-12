import type { Metadata } from "next";
import { SellerProfileClient } from "./seller-profile-client";

export const metadata: Metadata = {
  title: "Kinic Marketplace Seller",
  description: "Browse public Kinic Marketplace listings by seller."
};

export default async function SellerProfilePage({ params }: { params: Promise<{ principal: string }> }) {
  const { principal } = await params;
  return <SellerProfileClient canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""} principal={decodeURIComponent(principal)} />;
}
