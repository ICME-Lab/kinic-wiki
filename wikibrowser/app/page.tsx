import { Suspense } from "react";
import { HomePageClient } from "./home-page-client";

export default function HomePage() {
  return (
    <Suspense fallback={<HomePageFallback />}>
      <HomePageClient />
    </Suspense>
  );
}

function HomePageFallback() {
  return (
    <main className="min-h-screen px-6 pb-8 pt-6">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="rounded-lg border border-line bg-paper px-4 py-3 text-sm text-muted">Loading databases...</div>
      </section>
    </main>
  );
}
