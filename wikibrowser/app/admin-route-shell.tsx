// Where: wikibrowser admin routes.
// What: applies shared auth session, header, and sidebar only to console pages.
// Why: public database routes should not pay for management chrome during SSR or hydration.

import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin-shell";
import { AppHeader } from "./app-header";
import { AppSessionProvider } from "./app-session-provider";

export function AdminRouteShell({ children }: { children: ReactNode }) {
  return (
    <AppSessionProvider>
      <AppHeader />
      <AdminShell>{children}</AdminShell>
    </AppSessionProvider>
  );
}
