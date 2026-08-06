import { AppLink as Link } from "@/components/app-link";
import { AdminContent } from "@/components/admin-shell";
import { AdminNotice, AdminPanel } from "@/components/admin-ui";
import { Database, ExternalLink, Globe2, KeyRound, LayoutDashboard, MessageSquareText, Puzzle, ShieldCheck } from "lucide-react";

const CLIPPER_STORE_URL = "https://chromewebstore.google.com/detail/kinic-wiki-clipper/moebdnadaffhlddnhifmmdoecifhcbdi";

export const metadata: Record<string, unknown> = {
  title: "Kinic Wiki Clipper",
  description: "Save ChatGPT and Claude conversations or active web pages into a Kinic Wiki database, and understand how Clipper and Dashboard sign-in work.",
  openGraph: {
    title: "Kinic Wiki Clipper",
    description: "Save browser context under /Sources and open it from the Kinic Wiki Dashboard."
  },
  twitter: {
    title: "Kinic Wiki Clipper",
    description: "Save browser context under /Sources and open it from the Kinic Wiki Dashboard."
  }
};

const captureSources = [
  {
    icon: MessageSquareText,
    title: "ChatGPT conversations",
    path: "/Sources/chatgpt",
    text: "Export the recent conversations you choose as inspectable evidence."
  },
  {
    icon: MessageSquareText,
    title: "Claude conversations",
    path: "/Sources/claude",
    text: "Export the recent conversations you choose as inspectable evidence."
  },
  {
    icon: Globe2,
    title: "Active web pages",
    path: "/Sources/web",
    text: "Capture the current page as an inspectable web evidence source."
  }
];

const workflow = [
  { title: "Connect Clipper", text: "Open the extension settings and sign in with Internet Identity." },
  { title: "Choose a database", text: "Select an active database where your principal has writer access." },
  { title: "Capture a source", text: "Start an export in ChatGPT or Claude, or use the extension action on a web page." },
  { title: "Open the Dashboard", text: "Sign in to wiki.kinic.xyz with the same Internet Identity to find and manage that database." }
];

const sessions = [
  {
    label: "READ",
    title: "ChatGPT or Claude session",
    text: "Your existing provider session lets Clipper read only the conversations you ask it to export."
  },
  {
    label: "WRITE",
    title: "Clipper Internet Identity session",
    text: "Clipper uses its own Internet Identity delegation for database writes. It can stay signed in, so you may not see a login prompt every time."
  },
  {
    label: "MANAGE",
    title: "Dashboard Internet Identity session",
    text: "wiki.kinic.xyz keeps a separate browser session, so the Dashboard may ask you to sign in even while Clipper is already connected."
  }
];

export default function ClipperPage() {
  return (
    <AdminContent>
      <div className="flex flex-col gap-6">
        <AdminPanel className="min-w-0 overflow-hidden" padding="lg">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)] lg:items-center">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Puzzle aria-hidden className="text-accent" size={20} />
                <p className="text-sm font-semibold uppercase text-accentText">Browser capture</p>
              </div>
              <h1 className="mt-3 text-3xl font-semibold leading-tight text-ink">Save browser context with Wiki Clipper</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
                Kinic Wiki Clipper is a Chrome extension that saves selected ChatGPT and Claude conversations or the active web page into a writable Kinic Wiki database. Raw captures stay under <code>/Sources</code> so you can inspect their origin before turning them into maintained knowledge.
              </p>
              <a
                className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-action bg-action px-4 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                href={CLIPPER_STORE_URL}
                rel="noopener noreferrer"
                target="_blank"
              >
                Add to Chrome
                <ExternalLink aria-hidden size={16} />
              </a>
            </div>
            <div className="min-w-0 rounded-lg border border-line bg-white p-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="font-mono text-xs font-semibold text-accent">CAPTURE DESTINATION</p>
                  <h2 className="mt-2 text-base font-semibold text-ink">One extension, visible source routes</h2>
                </div>
                <code className="rounded-lg border border-accent bg-accentSoft px-2.5 py-1 text-xs font-semibold text-ink">/Sources</code>
              </div>
              <div className="mt-4 overflow-hidden rounded-lg border border-line">
                {captureSources.map((source, index) => (
                  <div className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-line" : ""}`} key={source.path}>
                    <span className="text-sm font-semibold text-ink">{source.title.replace(" conversations", "")}</span>
                    <code className="min-w-0 break-all text-right text-xs text-accentText">{source.path}</code>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </AdminPanel>

        <AdminPanel ariaLabel="Clipper capture sources" className="min-w-0 overflow-hidden" padding="none">
          <div className="grid md:grid-cols-3">
            {captureSources.map((source, index) => {
              const Icon = source.icon;
              return (
                <article className={`${index > 0 ? "border-t border-line md:border-l md:border-t-0" : ""} p-5`} key={source.title}>
                  <div className="flex items-center justify-between gap-3">
                    <Icon aria-hidden className="text-accent" size={20} />
                    <code className="min-w-0 break-all rounded bg-accentSoft px-2 py-1 text-right text-xs text-ink">{source.path}</code>
                  </div>
                  <h2 className="mt-4 text-lg font-semibold text-ink">{source.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-muted">{source.text}</p>
                </article>
              );
            })}
          </div>
        </AdminPanel>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <Database aria-hidden className="text-accent" size={19} />
            <h2 className="text-xl font-semibold text-ink">From capture to Dashboard</h2>
          </div>
          <ol className="mt-5 grid overflow-hidden rounded-lg border border-line bg-white md:grid-cols-2 xl:grid-cols-4">
            {workflow.map((step, index) => (
              <li
                className={`${index === 1 ? "border-t border-line md:border-l md:border-t-0" : index === 2 ? "border-t border-line xl:border-l xl:border-t-0" : index === 3 ? "border-t border-line md:border-l xl:border-t-0" : ""} p-4`}
                key={step.title}
              >
                <span className="inline-flex size-7 items-center justify-center rounded-full bg-accentSoft font-mono text-xs font-semibold text-accentText">{index + 1}</span>
                <h3 className="mt-2 text-base font-semibold text-ink">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{step.text}</p>
              </li>
            ))}
          </ol>
        </AdminPanel>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
            <div>
              <div className="flex items-center gap-2">
                <KeyRound aria-hidden className="text-accent" size={19} />
                <h2 className="text-xl font-semibold text-ink">Why does the Dashboard ask me to sign in again?</h2>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted">
                These are three separate sessions with different jobs. A remembered Clipper session is not an authentication bypass, and it does not automatically sign the Dashboard in.
              </p>
              <p className="mt-3 text-sm leading-6 text-muted">
                Use the same Internet Identity in Clipper and on wiki.kinic.xyz. Both derive the same Kinic Wiki principal, so the Dashboard can show the database that Clipper wrote to.
              </p>
            </div>
            <div className="grid gap-3">
              {sessions.map((session) => (
                <div className="grid gap-2 rounded-lg border border-line bg-white p-4 sm:grid-cols-[5rem_1fr]" key={session.label}>
                  <span className="font-mono text-xs font-semibold text-accent">{session.label}</span>
                  <div>
                    <h3 className="text-base font-semibold text-ink">{session.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-muted">{session.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </AdminPanel>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck aria-hidden className="text-accent" size={19} />
                <h2 className="text-xl font-semibold text-ink">Before you capture</h2>
              </div>
              <div className="mt-4">
                <AdminNotice tone="info" message="Clipper cannot save when its Internet Identity session is signed out, no destination database is selected, your principal does not have writer access, or the database does not have enough write cycles." />
              </div>
            </div>
            <Link className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-action bg-action px-4 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href="/dashboard">
              <LayoutDashboard aria-hidden size={17} />
              Open Dashboard
            </Link>
          </div>
        </AdminPanel>
      </div>
    </AdminContent>
  );
}
