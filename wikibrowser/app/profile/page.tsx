// Where: /profile route.
// What: hosts user-scoped ledger balance visibility.
// Why: direct wallet payments avoid canister-held token custody.
import { ProfileClient } from "./profile-client";

export const metadata: Record<string, unknown> = {
  title: "Kinic Wiki My Profile",
  description: "View your ledger KINIC balance for Kinic Wiki."
};

export default function ProfilePage() {
  return <ProfileClient canisterId={import.meta.env.VITE_KINIC_WIKI_CANISTER_ID || ""} />;
}
