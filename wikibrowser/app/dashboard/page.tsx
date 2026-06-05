import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardHomeClient } from "./dashboard-home-client";

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
    <main className="min-h-screen px-6 pb-8 pt-6">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="rounded-lg border border-line bg-paper px-4 py-3 text-sm text-muted">Loading databases...</div>
      </section>
    </main>
  );
}
