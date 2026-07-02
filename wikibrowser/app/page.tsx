// Where: wikibrowser/app/page.tsx
// What: Lightweight public landing page for the production Worker root route.
// Why: Cloudflare cold renders of the full marketing page can exceed Worker CPU on browser document requests.
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { publicDatabasePath } from "@/lib/share-links";

const linkPreviewImage = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Kinic Wiki Database Dashboard"
};

export const metadata: Metadata = {
  title: "Kinic Wiki AI Memory",
  description: "Use Kinic Wiki as canister-backed AI memory: raw evidence under /Sources, maintained knowledge under /Knowledge, and CLI-first agent workflows.",
  openGraph: {
    title: "Kinic Wiki AI Memory",
    description: "Use Kinic Wiki as canister-backed AI memory: raw evidence under /Sources, maintained knowledge under /Knowledge, and CLI-first agent workflows.",
    images: [linkPreviewImage]
  },
  twitter: {
    card: "summary_large_image",
    title: "Kinic Wiki AI Memory",
    description: "Use Kinic Wiki as canister-backed AI memory: raw evidence under /Sources, maintained knowledge under /Knowledge, and CLI-first agent workflows.",
    images: [
      {
        url: "/twitter-image",
        alt: linkPreviewImage.alt
      }
    ]
  }
};

const officialDatabaseHref = publicDatabasePath("db_kva4v2twg6jv");

const workflowSteps = [
  "Capture raw evidence under /Sources.",
  "Compile durable knowledge under /Knowledge.",
  "Search, cite, edit, and keep the wiki current with agents."
];

const wikiLayers = [
  {
    title: "Sources",
    text: "Raw evidence stays under /Sources, where agents and humans can inspect what claims came from."
  },
  {
    title: "Knowledge",
    text: "Synthesized pages live under /Knowledge as named, linked, updateable notes."
  },
  {
    title: "Agent maintenance",
    text: "Useful answers, contradictions, and links can be written back instead of disappearing into chat history."
  }
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
              Kinic Wiki is canister-backed AI memory for agents: raw evidence under <code className="rounded-md bg-accentSoft px-1.5 py-0.5 font-semibold text-ink">/Sources</code>, maintained knowledge under{" "}
              <code className="rounded-md bg-accentSoft px-1.5 py-0.5 font-semibold text-ink">/Knowledge</code>, and CLI-first workflows for search, citation, and safe edits.
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

      <section className="border-y border-line bg-white px-4 py-12 sm:px-6">
        <div className="mx-auto grid max-w-[1080px] gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start">
          <div>
            <p className="text-sm font-bold uppercase text-accent">Beyond one-shot RAG</p>
            <h2 className="mt-3 text-2xl font-semibold leading-tight text-ink">Sources become a maintained wiki, not only retrieved chunks.</h2>
            <p className="mt-4 text-sm leading-6 text-muted">
              Traditional RAG retrieves similar chunks at question time. Kinic Wiki turns sources into a durable, linked knowledge base that agents keep maintaining. Evidence stays under /Sources, synthesized knowledge lives under /Knowledge, and useful answers can become part of the wiki instead of disappearing into chat history.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {wikiLayers.map((layer) => (
              <article key={layer.title} className="rounded-lg border border-line bg-paper p-4">
                <p className="text-sm font-semibold text-ink">{layer.title}</p>
                <p className="mt-2 text-sm leading-6 text-muted">{layer.text}</p>
              </article>
            ))}
          </div>
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
