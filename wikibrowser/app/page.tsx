// Where: wikibrowser/app/page.tsx
// What: Lightweight public landing page for the production Worker root route.
// Why: Cloudflare cold renders of the full marketing page can exceed Worker CPU on browser document requests.
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { publicDatabasePath } from "@/lib/share-links";

export const metadata: Metadata = {
  title: "Kinic Wiki AI Memory",
  description: "Use Kinic Wiki as canister-backed AI memory through kinic-vfs-cli, with the browser UI as a companion surface.",
  openGraph: {
    title: "Kinic Wiki AI Memory",
    description: "Use Kinic Wiki as canister-backed AI memory through kinic-vfs-cli, with the browser UI as a companion surface."
  },
  twitter: {
    title: "Kinic Wiki AI Memory",
    description: "Use Kinic Wiki as canister-backed AI memory through kinic-vfs-cli, with the browser UI as a companion surface."
  }
};

const officialDatabaseHref = publicDatabasePath("db_kva4v2twg6jv");

const workflowSteps = [
  "Create and fund canister-backed databases.",
  "Browse /Knowledge and /Sources from the browser.",
  "Use kinic-vfs-cli as the primary agent interface."
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white text-ink">
      <section className="border-b border-line bg-paper px-4 py-5 sm:px-6">
        <nav className="mx-auto flex max-w-[1080px] flex-wrap items-center justify-between gap-3">
          <Link className="flex items-center gap-3 text-sm font-semibold text-ink no-underline" href="/">
            <Image className="h-10 w-10 rounded-lg" src="/kinic-mark.png" alt="" width={40} height={40} unoptimized />
            <span>Kinic Wiki</span>
          </Link>
          <div className="flex flex-wrap gap-2">
            <Link className="rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold text-ink no-underline hover:border-accent hover:text-accent" href="/cli">
              CLI
            </Link>
            <Link className="rounded-lg border border-action bg-action px-3 py-2 text-sm font-semibold text-white no-underline hover:border-accent hover:bg-accent" href="/dashboard">
              Dashboard
            </Link>
          </div>
        </nav>
      </section>

      <section className="relative isolate overflow-hidden px-4 py-16 sm:px-6 sm:py-20">
        <div className="absolute inset-y-0 right-0 -z-20 hidden w-[58%] lg:block">
          <Image className="object-cover object-[68%_50%] opacity-95" src="/home-hero.webp" alt="" fill priority sizes="58vw" unoptimized />
        </div>
        <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,#fff_0%,#fff_48%,rgba(255,255,255,0.82)_70%,rgba(255,255,255,0.28)_100%)]" />
        <div className="mx-auto grid max-w-[1080px] gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)] lg:items-center">
          <div className="min-h-[360px]">
            <p className="text-sm font-bold uppercase text-accent">CLI-first AI memory</p>
            <h1 className="mt-3 max-w-[650px] text-4xl font-semibold leading-[1.08] text-ink sm:text-5xl">Kinic Wiki is AI memory for agents</h1>
            <p className="mt-5 max-w-[620px] text-lg leading-7 text-muted">
              <code className="rounded-md bg-accentSoft px-1.5 py-0.5 font-semibold text-ink">kinic-vfs-cli</code> is the primary interface. The browser UI is a companion for inspection, editing, database management, and source capture.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link className="rounded-lg border border-action bg-action px-5 py-3 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent" href="/cli">
                Install CLI
              </Link>
              <Link className="rounded-lg border border-line bg-white px-5 py-3 text-sm font-bold text-ink no-underline hover:border-accent hover:text-accent" href={officialDatabaseHref}>
                Open Official Wiki
              </Link>
            </div>
          </div>

          <aside className="rounded-lg border border-line bg-paper p-5">
            <p className="text-sm font-semibold text-ink">Agent workflow</p>
            <pre className="mt-4 overflow-x-auto rounded-lg border border-line bg-white p-4 text-xs leading-6 text-ink">
              <code>{"npm install -g kinic-vfs-cli\nkinic-vfs-cli database link <database-id>\nkinic-vfs-cli search-remote \"query\" --prefix /Knowledge --json"}</code>
            </pre>
          </aside>
        </div>
      </section>

      <section className="bg-paper px-4 py-14 sm:px-6">
        <div className="mx-auto grid max-w-[1080px] gap-4 md:grid-cols-3">
          {workflowSteps.map((step, index) => (
            <article key={step} className="rounded-lg border border-line bg-white p-5">
              <p className="font-mono text-xs font-semibold text-accent">0{index + 1}</p>
              <p className="mt-3 text-sm leading-6 text-muted">{step}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
