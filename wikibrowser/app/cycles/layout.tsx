import type { ReactNode } from "react";
import { AdminRouteShell } from "@/app/admin-route-shell";

export default function CyclesLayout({ children }: { children: ReactNode }) {
  return <AdminRouteShell>{children}</AdminRouteShell>;
}
