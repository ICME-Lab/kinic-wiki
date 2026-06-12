// Where: /profile route.
// What: hosts user-scoped ledger balance visibility.
// Why: direct wallet payments avoid canister-held token custody.
import type { Metadata } from "next";
import { ProfileClient } from "./profile-client";

export const metadata: Metadata = {
  title: "Kinic Wiki My Profile",
  description: "View your ledger KINIC balance for Kinic Wiki."
};

export default function ProfilePage() {
  return <ProfileClient canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""} />;
}
