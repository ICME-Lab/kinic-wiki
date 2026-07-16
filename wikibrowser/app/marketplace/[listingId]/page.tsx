import { ListingDetailClient } from "./listing-detail-client";

export default function ListingDetailPage({ listingId }: { listingId: string }) {
  return <ListingDetailClient canisterId={import.meta.env.VITE_KINIC_WIKI_CANISTER_ID || ""} listingId={listingId} />;
}
