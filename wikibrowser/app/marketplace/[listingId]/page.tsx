import type { Metadata } from "next";
import { ListingDetailClient } from "./listing-detail-client";

export const metadata: Metadata = {
  title: "Kinic Marketplace Listing"
};

export default async function ListingDetailPage({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  return <ListingDetailClient canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""} listingId={listingId} />;
}
