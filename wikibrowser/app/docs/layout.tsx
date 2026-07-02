// Where: /docs route group.
// What: wraps documentation pages in the shared console shell.
// Why: docs belong with operator-facing console surfaces, but keep one layout boundary.
import type { ReactNode } from "react";
import { AdminRouteShell } from "@/app/admin-route-shell";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <AdminRouteShell>{children}</AdminRouteShell>;
}
