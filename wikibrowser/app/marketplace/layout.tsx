// Where: marketplace route group.
// What: keeps marketplace pages inside the shared admin shell.
// Why: marketplace-specific filters now live with the listing content.

import type { ReactNode } from "react";
import { AdminContent } from "@/components/admin-shell";

export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return <AdminContent>{children}</AdminContent>;
}
