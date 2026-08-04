import { AppLink as Link } from "@/components/app-link";
import { AdminContent } from "@/components/admin-shell";
import { AdminNotice, AdminPanel } from "@/components/admin-ui";
import { ArrowDown, ArrowRight, Database, Globe2, KeyRound, LayoutDashboard, MessageSquareText, Puzzle, ShieldCheck } from "lucide-react";

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
    text: "Export the recent conversations you choose as evidence under /Sources/chatgpt."
  },
  {
    icon: MessageSquareText,
    title: "Claude conversations",
    text: "Export the recent conversations you choose as evidence under /Sources/claude."
  },
  {
    icon: Globe2,
    title: "Active web pages",
    text: "Capture the current page as a web evidence source under /Sources/web."
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
            </div>
            <div className="grid items-center gap-2 rounded-lg border border-line bg-white p-4 text-center sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
              <FlowNode label="Browser" detail="ChatGPT · Claude · Web" />
              <FlowArrow />
              <FlowNode label="Wiki Clipper" detail="Authenticated capture" />
              <FlowArrow />
              <FlowNode label="Kinic Wiki" detail="/Sources" mono />
            </div>
          </div>
        </AdminPanel>

        <section className="grid gap-4 md:grid-cols-3" aria-label="Clipper capture sources">
          {captureSources.map((source) => {
            const Icon = source.icon;
            return (
              <AdminPanel className="min-w-0" key={source.title} padding="lg">
                <Icon aria-hidden className="text-accent" size={20} />
                <h2 className="mt-3 text-lg font-semibold text-ink">{source.title}</h2>
                <p className="mt-2 text-sm leading-6 text-muted">{source.text}</p>
              </AdminPanel>
            );
          })}
        </section>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <Database aria-hidden className="text-accent" size={19} />
            <h2 className="text-xl font-semibold text-ink">From capture to Dashboard</h2>
          </div>
          <ol className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {workflow.map((step, index) => (
              <li className="rounded-lg border border-line bg-white p-4" key={step.title}>
                <span className="font-mono text-xs font-semibold text-accent">0{index + 1}</span>
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
                <AdminNotice tone="info" message="Clipper cannot save when its Internet Identity session is signed out, no destination database is selected, or your principal does not have writer access to that database." />
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

function FlowArrow() {
  return (
    <>
      <ArrowDown aria-hidden className="mx-auto text-accent sm:hidden" size={18} />
      <ArrowRight aria-hidden className="hidden text-accent sm:block" size={18} />
    </>
  );
}

function FlowNode({ detail, label, mono = false }: { detail: string; label: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-sm font-semibold text-ink">{label}</p>
      <p className={`${mono ? "font-mono" : ""} mt-1 break-words text-xs leading-5 text-muted`}>{detail}</p>
    </div>
  );
}
