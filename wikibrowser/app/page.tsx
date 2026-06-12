import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BookOpen, Database, Search, ShieldCheck, TerminalSquare, Wrench } from "lucide-react";
import { publicDatabasePath } from "@/lib/share-links";
import heroImage from "./home-hero.png";

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

const workflowSteps = [
  {
    title: "Create databases",
    body: "Create a writable Kinic Wiki database and open the same database from browser management views."
  },
  {
    title: "Manage access and cycles",
    body: "Grant writers, inspect members, and fund cycles without leaving the browser companion."
  },
  {
    title: "Browse and edit",
    body: "Inspect public databases, browse wiki paths, and make manual Markdown edits when operators need a visual surface."
  }
];

const companionSurfaces = [
  {
    title: "Dashboard",
    body: "Create databases, inspect public entries, manage access, and fund cycles from the browser companion.",
    icon: Database
  },
  {
    title: "Official wiki",
    body: "Open the public Kinic Wiki example in the wiki browser to inspect how /Wiki and /Sources are organized.",
    href: publicDatabasePath("db_kva4v2twg6jv"),
    label: "Open Official Wiki",
    icon: BookOpen
  },
  {
    title: "Capture tools",
    body: "Save ChatGPT/Claude conversations as raw sources and queue active web pages as URL ingest requests. The extension requires Internet Identity writer access; use the CLI to turn raw chats into organized /Wiki pages.",
    details: ["Web pages -> /Sources/ingest-requests/...", "AI chats -> /Sources/raw/..."],
    href: "https://chromewebstore.google.com/detail/moebdnadaffhlddnhifmmdoecifhcbdi",
    label: "Chrome Extension",
    icon: Wrench
  }
];

const commandLines = [
  "npm install -g kinic-vfs-cli",
  "kinic-vfs-cli database link <database-id>",
  'kinic-vfs-cli search-remote "query" --prefix /Wiki --json'
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white text-ink">
      <section className="relative isolate min-h-[100svh] overflow-hidden bg-white px-4 py-7 sm:px-6">
        <Image className="absolute inset-0 -z-20 h-full w-full object-cover object-[84%_42%] sm:object-[70%_50%]" src={heroImage} alt="" fill priority sizes="100vw" />
        <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(255,255,255,0.995)_0%,rgba(255,255,255,0.98)_58%,rgba(255,255,255,0.78)_100%)] sm:bg-[linear-gradient(90deg,rgba(255,255,255,0.99)_0%,rgba(255,255,255,0.94)_36%,rgba(255,255,255,0.48)_70%,rgba(255,255,255,0.10)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 -z-10 h-36 bg-gradient-to-t from-white via-white/80 to-white/0" />

        <div className="mx-auto flex min-h-[calc(100svh-56px)] max-w-[1155px] flex-col gap-12 sm:gap-16">
          <nav className="flex flex-wrap items-center justify-between gap-3">
            <Link className="inline-flex items-center gap-3 rounded-2xl no-underline transition-transform hover:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href="/" aria-label="Kinic Wiki home">
              <Image className="h-12 w-12 rounded-2xl shadow-sm" src="/kinic-mark.png" alt="" width={48} height={48} unoptimized />
              <span className="text-sm font-semibold text-ink">Kinic Wiki</span>
            </Link>
            <Link className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-line bg-white px-4 py-2 text-sm font-bold text-ink no-underline shadow-[0_4px_10px_#14142b0a] transition-[transform,background-color,border-color,color,box-shadow] hover:-translate-y-[3px] hover:border-accent hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0" href="/dashboard">
              <Database aria-hidden size={16} />
              <span>Dashboard</span>
            </Link>
          </nav>

          <div className="max-w-[640px] pb-16 sm:pb-20">
            <p className="text-sm font-bold uppercase text-accent">CLI-first AI memory</p>
            <h1 className="mt-3 max-w-[620px] text-4xl font-semibold leading-[1.08] text-ink sm:text-5xl lg:text-6xl">Kinic Wiki is AI memory for agents</h1>
            <p className="mt-4 max-w-[574px] text-lg leading-[1.5] text-muted sm:text-xl">
              <code className="rounded-md bg-accentSoft px-1.5 py-0.5 font-semibold text-ink">kinic-vfs-cli</code> is the primary interface. The browser UI is a companion for inspection, editing, and database management.
            </p>
            <div className="mt-7 grid gap-3 sm:flex sm:flex-wrap">
              <Link className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl border border-action bg-action px-4 py-4 text-sm font-bold text-white no-underline transition-[transform,background-color,border-color,color,box-shadow] hover:-translate-y-[3px] hover:border-accent hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:w-auto sm:px-6 sm:text-base" href="/cli">
                <TerminalSquare aria-hidden size={16} />
                <span>Install CLI</span>
              </Link>
              <a className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl border border-line bg-white px-4 py-4 text-sm font-bold text-ink no-underline shadow-[0_4px_10px_#14142b0a] transition-[transform,background-color,border-color,color,box-shadow] hover:-translate-y-[3px] hover:border-accent hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:w-auto sm:px-5 sm:text-base" href="https://chromewebstore.google.com/detail/moebdnadaffhlddnhifmmdoecifhcbdi" rel="noopener noreferrer" target="_blank">
                <Wrench aria-hidden size={16} />
                <span>Chrome Extension</span>
                <span className="sr-only">opens in new tab</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-paper px-4 pb-20 pt-32 sm:px-6 sm:pb-20 sm:pt-28 lg:pb-24 lg:pt-32">
        <div className="mx-auto max-w-[1155px]">
          <div className="mx-auto max-w-[574px] text-center">
            <p className="text-sm font-bold text-accent">Meet Kinic Wiki</p>
            <h2 className="mt-3 text-3xl font-semibold leading-[1.18] text-ink [text-wrap:balance] sm:text-4xl lg:text-5xl">Use the CLI first. Manage the same memory in the browser.</h2>
          </div>

          <div className="mt-10 grid gap-7 lg:grid-cols-2 lg:items-start">
            <article className="min-w-0 rounded-2xl bg-white p-5">
              <div className="flex items-center justify-between gap-3 border-b border-line pb-4">
                <div className="flex items-center gap-2">
                  <TerminalSquare aria-hidden className="text-accent" size={18} />
                  <h3 className="text-lg font-semibold text-ink">Agent CLI workflow</h3>
                </div>
                <span className="rounded-lg border border-line bg-paper px-2 py-1 text-[11px] font-semibold text-muted">For agents</span>
              </div>
              <p className="mt-4 text-sm leading-6 text-muted">
                Connect your agent to a Kinic Wiki database, then search, read, and update durable memory from the CLI.
              </p>
              <pre className="mt-5 max-w-full overflow-x-auto rounded-2xl border border-line bg-paper p-4 text-xs leading-6 text-ink">
                <code>{commandLines.join("\n")}</code>
              </pre>
            </article>

            <article className="rounded-2xl bg-white p-5">
              <div className="flex items-center gap-2 border-b border-line pb-4">
                <Database aria-hidden className="text-accent" size={18} />
                <h3 className="text-lg font-semibold text-ink">Browser companion</h3>
              </div>
              <p className="mt-4 text-sm leading-6 text-muted">
                Use the Dashboard and wiki browser for database creation, public browsing, manual edits, cycles funding, and access management.
              </p>
              <div className="mt-5 grid gap-3">
                {workflowSteps.map((step, index) => (
                  <div key={step.title} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-4 rounded-2xl border border-line bg-paper p-4">
                    <p className="flex size-10 items-center justify-center rounded-xl bg-white font-mono text-xs font-semibold text-accent">0{index + 1}</p>
                    <div>
                      <h4 className="font-semibold text-ink">{step.title}</h4>
                      <p className="mt-1 text-sm leading-6 text-muted">{step.body}</p>
                    </div>
                  </div>
                ))}
              </div>
              <Link className="mt-6 inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-action bg-action px-5 py-3 text-sm font-bold text-white no-underline transition-[transform,background-color,border-color,color,box-shadow] hover:-translate-y-[3px] hover:border-accent hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0" href="/dashboard">
                <Database aria-hidden size={16} />
                <span>Open Dashboard</span>
              </Link>
            </article>
          </div>
        </div>
      </section>

      <section className="bg-white px-4 pb-20 pt-20 sm:px-6 sm:pt-24 lg:pb-28 lg:pt-28">
        <div className="mx-auto max-w-[1155px]">
          <div className="mx-auto max-w-[574px] text-center">
            <p className="text-sm font-bold text-accent">How it stays useful</p>
            <h2 className="mt-3 text-3xl font-semibold leading-[1.18] text-ink [text-wrap:balance] sm:text-4xl lg:text-5xl">A durable memory surface for agents and operators.</h2>
          </div>

          <div className="mt-10 grid gap-7 lg:grid-cols-3 lg:items-start">
            {companionSurfaces.map((surface) => {
              const Icon = surface.icon;
              const href = surface.href;
              const label = surface.label ?? surface.title;
              const linkClassName = "mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-line bg-white px-4 py-3 text-sm font-bold text-ink no-underline shadow-[0_4px_10px_#14142b0a] transition-[transform,background-color,border-color,color,box-shadow] hover:-translate-y-[3px] hover:border-accent hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0";
              return (
                <article key={surface.title} className="overflow-hidden rounded-2xl bg-paper p-6">
                  <div className="flex size-12 items-center justify-center rounded-2xl bg-white text-accent">
                    <Icon aria-hidden size={20} />
                  </div>
                  <h3 className="mt-5 text-xl font-semibold text-ink">{surface.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-muted">{surface.body}</p>
                  {surface.details ? (
                    <ul className="mt-4 grid gap-2 text-xs font-semibold text-muted [overflow-wrap:anywhere]">
                      {surface.details.map((detail) => (
                        <li key={detail} className="rounded-xl border border-line bg-white px-3 py-2">
                          {detail}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {href?.startsWith("http") ? (
                    <a className={linkClassName} href={href} rel="noopener noreferrer" target="_blank">
                      <span>{label}</span>
                      <span className="sr-only">opens in new tab</span>
                    </a>
                  ) : href ? (
                    <Link className={linkClassName} href={href}>
                      <span>{label}</span>
                    </Link>
                  ) : null}
                </article>
              );
            })}
          </div>

          <div className="mt-7 grid gap-7 lg:grid-cols-2">
            <article className="rounded-2xl bg-paper p-6">
              <div className="flex items-center gap-2">
                <Search aria-hidden className="text-accent" size={18} />
                <h3 className="text-xl font-semibold text-ink">Memory shape</h3>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted">
                Structured notes live under <code>/Wiki/...</code>. Raw evidence lives under <code>/Sources/raw/...</code>. Agents can search, follow paths and links, and update named knowledge nodes.
              </p>
            </article>
            <article className="rounded-2xl bg-paper p-6">
              <div className="flex items-center gap-2">
                <ShieldCheck aria-hidden className="text-accent" size={18} />
                <h3 className="text-xl font-semibold text-ink">Safe edits</h3>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted">
                Agents read current etags before mutation, so wiki changes remain explicit when operators and automated workflows touch the same memory.
              </p>
            </article>
          </div>
        </div>
      </section>
    </main>
  );
}
