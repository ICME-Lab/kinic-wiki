// Where: wikibrowser/app/page.tsx
// What: Lightweight public landing page for the production Worker root route.
// Why: Cloudflare cold renders of the full marketing page can exceed Worker CPU on browser document requests.
import { AppLink as Link } from "@/components/app-link";
import type { ReactNode } from "react";

const APP_STORE_URL = "https://apps.apple.com/us/app/kinicwiki-ai-memory/id6785718977";
const CLIPPER_STORE_URL = "https://chromewebstore.google.com/detail/kinic-wiki-clipper/moebdnadaffhlddnhifmmdoecifhcbdi";

const linkPreviewImage = {
  url: "/opengraph-image.png",
  width: 1200,
  height: 630,
  alt: "Kinic Wiki Database Dashboard"
};

export const metadata: Record<string, unknown> = {
  title: "Kinic Wiki AI Memory",
  description: "Capture pages and conversations under /Sources, maintain durable knowledge under /Knowledge, and ask questions with the evidence attached.",
  openGraph: {
    title: "Kinic Wiki AI Memory",
    description: "Capture pages and conversations under /Sources, maintain durable knowledge under /Knowledge, and ask questions with the evidence attached.",
    images: [linkPreviewImage]
  },
  twitter: {
    card: "summary_large_image",
    title: "Kinic Wiki AI Memory",
    description: "Capture pages and conversations under /Sources, maintain durable knowledge under /Knowledge, and ask questions with the evidence attached.",
    images: [
      {
        url: "/twitter-image.png",
        alt: linkPreviewImage.alt
      }
    ]
  }
};

const memoryStages = [
  {
    number: "01",
    label: "Capture",
    title: "Keep the original context.",
    text: "Save a Safari page, a browser conversation, or an agent-provided source before the useful details disappear.",
    path: "/Sources"
  },
  {
    number: "02",
    label: "Organize",
    title: "Turn evidence into a wiki.",
    text: "Review, link, and maintain named pages without losing the source material behind each claim.",
    path: "/Knowledge"
  },
  {
    number: "03",
    label: "Ask",
    title: "Check the answer against your notes.",
    text: "Ask one selected database and open the cited documents that supported the response.",
    path: "cited answer"
  }
];

const trustPoints = [
  {
    label: "Canister-backed storage",
    text: "Your selected Kinic Wiki database stays at the center across mobile, browser, dashboard, and agent workflows."
  },
  {
    label: "Inspectable evidence",
    text: "Raw captures remain visible under /Sources instead of being hidden inside an opaque retrieval index."
  },
  {
    label: "Answers you can trace",
    text: "Grounded answers link back to the database notes used to produce them, so they can be reviewed and corrected."
  }
];

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

export default function HomePage() {
  return (
    <main className="min-h-screen overflow-hidden bg-white text-ink">
      <header className="border-b border-line bg-white px-4 py-4 sm:px-6">
        <nav className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3" aria-label="Primary navigation">
          <Link className={`flex items-center gap-3 rounded-lg text-sm font-semibold text-ink no-underline ${focusRing}`} href="/">
            <img className="h-10 w-10 rounded-lg" src="/kinic-mark.png" alt="" width={40} height={40} />
            <span>Kinic Wiki</span>
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <Link className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-muted no-underline hover:bg-paper hover:text-accentText ${focusRing}`} href="/docs">
              Docs
            </Link>
            <Link className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-muted no-underline hover:bg-paper hover:text-accentText ${focusRing}`} href="/ios">
              iOS
            </Link>
            <Link className={`inline-flex min-h-11 items-center rounded-lg border border-action bg-action px-4 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent ${focusRing}`} href="/dashboard">
              Open Dashboard
            </Link>
          </div>
        </nav>
      </header>

      <section className="relative isolate border-b border-line px-4 pb-16 pt-14 sm:px-6 sm:pb-20 sm:pt-20">
        <div className="absolute left-1/2 top-0 -z-10 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(255,129,190,0.16)_0%,rgba(255,255,255,0)_70%)]" aria-hidden="true" />
        <div className="mx-auto max-w-[1180px]">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.56fr)] lg:items-end">
            <div>
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">AI memory with visible sources</p>
              <h1 className="mt-4 max-w-[800px] text-5xl font-semibold leading-[0.98] tracking-[-0.055em] text-ink sm:text-7xl">AI memory that keeps its sources.</h1>
            </div>
            <div className="lg:pb-1">
              <p className="max-w-[520px] text-base leading-7 text-muted sm:text-lg sm:leading-8">
                Capture pages and conversations under <code className="rounded bg-accentSoft px-1.5 py-0.5 text-sm font-semibold text-ink">/Sources</code>, maintain durable knowledge under{" "}
                <code className="rounded bg-accentSoft px-1.5 py-0.5 text-sm font-semibold text-ink">/Knowledge</code>, and ask questions with the evidence attached.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link className={`inline-flex min-h-12 items-center justify-center rounded-xl border border-action bg-action px-5 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent ${focusRing}`} href="/dashboard">
                  Open Dashboard
                </Link>
                <a className={`inline-flex min-h-12 items-center justify-center rounded-xl border border-line bg-white px-5 text-sm font-bold text-ink no-underline hover:border-accent hover:bg-accentSoft ${focusRing}`} href="#memory-flow">
                  See how it works
                </a>
              </div>
            </div>
          </div>

          <MemoryMap />
        </div>
      </section>

      <section className="bg-paper px-4 py-16 sm:px-6 sm:py-20" id="memory-flow">
        <div className="mx-auto max-w-[1180px]">
          <div className="max-w-[720px]">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">One continuous memory</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-[-0.035em] text-ink sm:text-4xl">Capture the context. Maintain the knowledge. Check the answer.</h2>
          </div>
          <ol className="mt-10 grid overflow-hidden rounded-2xl border border-line bg-white lg:grid-cols-3">
            {memoryStages.map((stage, index) => (
              <li className={`p-6 sm:p-7 ${index > 0 ? "border-t border-line lg:border-l lg:border-t-0" : ""}`} key={stage.label}>
                <div className="flex items-center justify-between gap-4">
                  <span className="font-mono text-xs font-semibold text-accentText">{stage.number} · {stage.label.toUpperCase()}</span>
                  <code className="rounded-lg border border-accentLine bg-accentSoft px-2.5 py-1 text-[11px] font-semibold text-ink">{stage.path}</code>
                </div>
                <h3 className="mt-7 text-xl font-semibold tracking-[-0.025em] text-ink">{stage.title}</h3>
                <p className="mt-3 text-sm leading-6 text-muted">{stage.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-y border-line bg-white px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto max-w-[1180px]">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div className="max-w-[700px]">
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">Choose your surface</p>
              <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-[-0.035em] text-ink sm:text-4xl">One database, four ways to use it.</h2>
            </div>
            <p className="max-w-[400px] text-sm leading-6 text-muted">Start with the tool that fits the context. Each one returns to the same Kinic Wiki memory.</p>
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <SurfaceCard eyebrow="iPhone + iPad" title="KinicWiki for iOS" description="Save from Safari, browse your wiki, and ask database-scoped questions with cited notes." marker="IOS">
              <a className={`inline-flex min-h-11 items-center justify-center rounded-lg border border-action bg-action px-4 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent ${focusRing}`} href={APP_STORE_URL} rel="noopener noreferrer" target="_blank">
                Get the iOS app
              </a>
              <Link className={`inline-flex min-h-11 items-center justify-center rounded-lg border border-line bg-white px-4 text-sm font-bold text-ink no-underline hover:border-accent hover:bg-accentSoft ${focusRing}`} href="/docs/ios">
                iOS setup &amp; troubleshooting
              </Link>
            </SurfaceCard>

            <SurfaceCard eyebrow="Browser capture" title="Wiki Clipper" description="Save selected ChatGPT and Claude conversations or the active page as inspectable evidence." marker="WEB">
              <a className={`inline-flex min-h-11 items-center justify-center rounded-lg border border-action bg-action px-4 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent ${focusRing}`} href={CLIPPER_STORE_URL} rel="noopener noreferrer" target="_blank">
                Install Clipper
              </a>
              <Link className={`inline-flex min-h-11 items-center justify-center rounded-lg border border-line bg-white px-4 text-sm font-bold text-ink no-underline hover:border-accent hover:bg-accentSoft ${focusRing}`} href="/docs/clipper">
                Read the Clipper guide
              </Link>
            </SurfaceCard>

            <SurfaceCard eyebrow="Agent workflows" title="Kinic VFS CLI" description="Let agents and scripts search, cite, edit, and keep stored knowledge current." marker="CLI">
              <Link className={`inline-flex min-h-11 items-center justify-center rounded-lg border border-action bg-action px-4 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent ${focusRing}`} href="/docs/cli">
                Install the CLI
              </Link>
            </SurfaceCard>

            <SurfaceCard eyebrow="Web management" title="Dashboard" description="Open the databases linked to your Internet Identity and manage access, cycles, and stored pages." marker="DB">
              <Link className={`inline-flex min-h-11 items-center justify-center rounded-lg border border-action bg-action px-4 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent ${focusRing}`} href="/dashboard">
                Open Dashboard
              </Link>
            </SurfaceCard>
          </div>
        </div>
      </section>

      <section className="bg-paper px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto grid max-w-[1180px] gap-10 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] lg:items-start">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">Built to stay inspectable</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-[-0.035em] text-ink sm:text-4xl">Memory is useful when you can correct it.</h2>
            <p className="mt-5 max-w-[490px] text-base leading-7 text-muted">Kinic Wiki keeps storage, evidence, and answers as separate things with visible relationships between them.</p>
          </div>
          <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
            {trustPoints.map((point) => (
              <article className="grid gap-2 px-5 py-5 sm:grid-cols-[190px_minmax(0,1fr)] sm:gap-8 sm:px-6" key={point.label}>
                <h3 className="text-sm font-semibold text-ink">{point.label}</h3>
                <p className="text-sm leading-6 text-muted">{point.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-line bg-white px-4 py-14 sm:px-6 sm:py-16">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-6 rounded-2xl border border-line bg-paper px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">Your database is the center</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em] text-ink">Open the memory you want to maintain.</h2>
          </div>
          <Link className={`inline-flex min-h-12 shrink-0 items-center justify-center rounded-xl border border-action bg-action px-5 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent ${focusRing}`} href="/dashboard">
            Open Dashboard
          </Link>
        </div>
      </section>

      <footer className="border-t border-line bg-white px-4 py-6 text-sm text-muted sm:px-6">
        <nav className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3" aria-label="Footer navigation">
          <span>Kinic Wiki</span>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Link className={`text-muted underline-offset-4 hover:text-accent hover:underline ${focusRing}`} href="/docs">Docs</Link>
            <Link className={`text-muted underline-offset-4 hover:text-accent hover:underline ${focusRing}`} href="/ios">iOS App</Link>
            <Link className={`text-muted underline-offset-4 hover:text-accent hover:underline ${focusRing}`} href="/support">Support</Link>
            <Link className={`text-muted underline-offset-4 hover:text-accent hover:underline ${focusRing}`} href="/privacy-policy">Privacy Policy</Link>
          </div>
        </nav>
      </footer>
    </main>
  );
}

function MemoryMap() {
  return (
    <figure className="relative mt-14 overflow-hidden rounded-[1.75rem] border border-line bg-[#f8f8f8] p-4 shadow-[0_26px_80px_rgba(0,0,0,0.06)] sm:p-6 lg:mt-16 lg:p-8" aria-labelledby="memory-map-title">
      <div className="absolute -right-20 -top-24 size-64 rounded-full border border-accentLine bg-accentSoft" aria-hidden="true" />
      <figcaption className="relative flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5">
        <div>
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-accentText">Live memory map</p>
          <h2 className="mt-1 text-base font-semibold text-ink" id="memory-map-title">Every answer has a route back to evidence.</h2>
        </div>
        <span className="rounded-full border border-accentLine bg-white px-3 py-1 font-mono text-[10px] font-semibold text-accentText">DATABASE-SCOPED</span>
      </figcaption>

      <div className="relative mt-6 grid items-center gap-0 lg:grid-cols-[minmax(150px,0.92fr)_44px_minmax(150px,1fr)_44px_minmax(150px,1fr)_44px_minmax(170px,1.08fr)]">
        <div className="grid gap-2" aria-label="Capture inputs">
          <MapInput label="iOS" marker="IOS" detail="Safari pages" />
          <MapInput label="Clipper" marker="WEB" detail="Browser context" />
          <MapInput label="CLI" marker="CLI" detail="Agent evidence" />
        </div>
        <MapConnector />
        <MapNode eyebrow="CAPTURE" path="/Sources" text="Raw evidence stays inspectable." />
        <MapConnector />
        <MapNode eyebrow="ORGANIZE" path="/Knowledge" text="Named pages stay linked and editable." badge="Dashboard" />
        <MapConnector />
        <MapNode eyebrow="ASK" path="cited answer" text="Supporting notes stay attached." citation />
      </div>
    </figure>
  );
}

function MapInput({ detail, label, marker }: { detail: string; label: string; marker: string }) {
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-3 rounded-xl border border-line bg-white p-3">
      <span className="grid size-11 place-items-center rounded-lg bg-black font-mono text-[10px] font-bold text-white" aria-hidden="true">{marker}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="mt-0.5 block text-xs text-muted">{detail}</span>
      </span>
    </div>
  );
}

function MapConnector() {
  return (
    <div className="grid h-12 place-items-center lg:h-auto" aria-hidden="true">
      <span className="relative block h-8 w-px bg-accentLine lg:h-px lg:w-full">
        <span className="absolute -bottom-0.5 -right-[3px] size-2 rounded-full bg-accent lg:-right-0.5 lg:-top-[3px]" />
      </span>
    </div>
  );
}

function MapNode({ badge, citation = false, eyebrow, path, text }: { badge?: string; citation?: boolean; eyebrow: string; path: string; text: string }) {
  return (
    <div className={`min-h-[148px] rounded-2xl border bg-white p-5 text-ink ${citation ? "border-[#2d68ff]" : "border-accentLine"}`}>
      <div className="flex items-center justify-between gap-3">
        <span className={`font-mono text-[10px] font-semibold tracking-[0.14em] ${citation ? "text-[#2d68ff]" : "text-accentText"}`}>{eyebrow}</span>
        {badge ? <span className="rounded-full border border-line bg-paper px-2 py-1 font-mono text-[9px] font-semibold text-muted">{badge}</span> : null}
      </div>
      <code className={`mt-6 block text-base font-semibold ${citation ? "text-[#2d68ff]" : ""}`}>{path}</code>
      <p className="mt-2 text-xs leading-5 text-muted">{text}</p>
    </div>
  );
}

function SurfaceCard({ children, description, eyebrow, marker, title }: { children: ReactNode; description: string; eyebrow: string; marker: string; title: string }) {
  return (
    <article className="group flex min-h-[280px] flex-col rounded-2xl border border-line bg-paper p-5 hover:border-accentLine hover:bg-white sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-accentText">{eyebrow}</p>
          <h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-ink">{title}</h3>
        </div>
        <span className="grid size-12 shrink-0 place-items-center rounded-xl border border-line bg-white font-mono text-[10px] font-bold text-ink group-hover:border-accentLine group-hover:text-accentText" aria-hidden="true">{marker}</span>
      </div>
      <p className="mt-5 max-w-[520px] text-sm leading-6 text-muted">{description}</p>
      <div className="mt-auto flex flex-wrap gap-3 pt-7">{children}</div>
    </article>
  );
}
