// Where: /profile route.
// What: hosts user-scoped App KINIC balance and deposit controls.
// Why: account funding belongs to the user profile, not DB cycles funding.
import type { Metadata } from "next";
import { ProfileClient } from "./profile-client";

export const metadata: Metadata = {
  title: "Kinic Wiki My Profile",
  description: "Manage App KINIC balance for Kinic Wiki."
};

export default function ProfilePage() {
  return <ProfileClient canisterId={process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID || ""} />;
}
