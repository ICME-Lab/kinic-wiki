import type { ReactNode } from "react";
import { AdminRouteShell } from "@/app/admin-route-shell";

export default function CanisterApiLayout({ children }: { children: ReactNode }) {
  return <AdminRouteShell>{children}</AdminRouteShell>;
}
