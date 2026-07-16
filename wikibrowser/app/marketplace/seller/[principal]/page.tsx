import { SellerProfileClient } from "./seller-profile-client";

export default function SellerProfilePage({ principal }: { principal: string }) {
  return <SellerProfileClient canisterId={import.meta.env.VITE_KINIC_WIKI_CANISTER_ID || ""} principal={decodeURIComponent(principal)} />;
}
