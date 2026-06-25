import type { ReactNode } from "react";
import { AdminRouteShell } from "@/app/admin-route-shell";

export default function MetricsLayout({ children }: { children: ReactNode }) {
  return <AdminRouteShell>{children}</AdminRouteShell>;
}
