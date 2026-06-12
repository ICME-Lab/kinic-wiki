import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardHomeClient } from "./dashboard-home-client";
import { AdminContent } from "@/components/admin-shell";

export const metadata: Metadata = {
  title: "Kinic Wiki Database Dashboard",
  description: "Browse, create, fund, and manage Kinic Wiki canister databases.",
  openGraph: {
    title: "Kinic Wiki Database Dashboard",
    description: "Browse, create, fund, and manage Kinic Wiki canister databases."
  },
  twitter: {
    title: "Kinic Wiki Database Dashboard",
    description: "Browse, create, fund, and manage Kinic Wiki canister databases."
  }
};

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardHomeFallback />}>
      <DashboardHomeClient />
    </Suspense>
  );
}

function DashboardHomeFallback() {
  return (
    <AdminContent>
      <div className="rounded-lg border border-line bg-paper px-4 py-3 text-sm text-muted">Loading databases...</div>
    </AdminContent>
  );
}
