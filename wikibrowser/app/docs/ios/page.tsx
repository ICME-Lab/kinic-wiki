// Where: /docs/ios.
// What: explains setup, capture results, and recovery for Save to KinicWiki.
// Why: the public iOS overview handles product discovery while this page resolves operational questions.
import { AppLink as Link } from "@/components/app-link";
import { AdminContent } from "@/components/admin-shell";
import { CheckCircle2, Clock3, Database, ExternalLink, History, KeyRound, Languages, Link2, RotateCcw, ShieldCheck, Smartphone } from "lucide-react";

const APP_STORE_URL = "https://apps.apple.com/us/app/kinicwiki-ai-memory/id6785718977";

export const metadata: Record<string, unknown> = {
  title: "KinicWiki iOS Setup Guide",
  description: "Set up Save to KinicWiki, understand Share Extension results, and recover captures from Capture history.",
  openGraph: {
    title: "KinicWiki iOS Setup Guide",
    description: "Prepare a writable database, save Safari and X URLs, and recover captures that need a retry."
  },
  twitter: {
    title: "KinicWiki iOS Setup Guide",
    description: "Prepare a writable database, save Safari and X URLs, and recover captures that need a retry."
  }
};

const guideStages = ["Prepare the app", "Share one URL", "Read the result", "Recover if needed"];

const requirements = [
  {
    icon: Smartphone,
    title: "iOS 18 or later",
    text: "KinicWiki supports iPhone and iPad devices running iOS or iPadOS 18 and later."
  },
  {
    icon: KeyRound,
    title: "Internet Identity",
    text: "Sign in with the Internet Identity that can access the destination database."
  },
  {
    icon: Database,
    title: "A writable database",
    text: "Capture needs an active Owner or Writer database with enough write cycles. Reader access is enough for Browse."
  }
];

const shareSteps = [
  {
    title: "Prepare KinicWiki once",
    text: "Open the app, sign in with Internet Identity, and confirm that an active Owner or Writer database appears."
  },
  {
    title: "Open Save to KinicWiki",
    text: "From a Safari page or an X post, open the Share Sheet and choose Save to KinicWiki. If it is hidden, add it from the Share Sheet's app customization."
  },
  {
    title: "Choose where the URL belongs",
    text: "Select a writable database and tap Save. The Share Extension remembers that destination but still shows it before the next save."
  },
  {
    title: "Review the generated source",
    text: "Open Capture history to follow processing, then open the finished evidence under /Sources."
  }
];

const captureResults = [
  {
    icon: CheckCircle2,
    title: "Capture started",
    text: "The request was saved and source generation started. You can close the Share Sheet."
  },
  {
    icon: Clock3,
    title: "Saved for later",
    text: "The URL is in an on-device queue. Open KinicWiki after restoring sign-in or connectivity so it can submit the request."
  },
  {
    icon: RotateCcw,
    title: "Saved, retry required",
    text: "The request reached the database, but processing did not start. Open Capture history and retry it."
  }
];

const operationalNotes = [
  {
    icon: History,
    title: "Capture history",
    text: "Use Capture history to inspect requests that are processing, waiting on the device, or ready for a manual retry."
  },
  {
    icon: Languages,
    title: "Output Language",
    text: "A language change applies to the next capture without changing content already queued or stored."
  },
  {
    icon: ShieldCheck,
    title: "Local data",
    text: "Ask AI history stays on this device in a separate namespace for each signed-in principal. Generation request data is discarded after processing."
  }
];

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

export default function IOSGuidePage() {
  return (
    <AdminContent>
      <div className="flex flex-col gap-6 pb-4">
        <section className="relative min-w-0 overflow-hidden rounded-[2rem] border border-line bg-white p-6 shadow-[0_18px_50px_rgba(23,37,58,0.08)] sm:p-8 lg:p-10">
          <div className="absolute inset-y-0 right-0 hidden w-[38%] bg-paper lg:block" />
          <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.58fr)] lg:items-center">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <img className="size-14 rounded-2xl shadow-[0_10px_28px_rgba(23,37,58,0.14)]" src="/ios/app-icon.webp" alt="KinicWiki app icon" width={56} height={56} />
                <div>
                  <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">Setup &amp; troubleshooting</p>
                  <p className="mt-1 text-sm text-muted">iPhone + iPad</p>
                </div>
              </div>
              <h1 className="mt-6 max-w-[680px] text-3xl font-semibold leading-[1.08] tracking-[-0.04em] text-ink sm:text-5xl">Set up Save to KinicWiki.</h1>
              <p className="mt-5 max-w-[650px] text-base leading-7 text-muted">
                Prepare a writable database, share one Safari or X URL, understand the result, and recover anything that needs another try.
              </p>
              <Link className={`mt-7 inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-white px-4 text-sm font-bold text-ink no-underline hover:border-accent hover:bg-accentSoft ${focusRing}`} href="/ios">
                See what the app does
              </Link>
            </div>

            <ol className="relative overflow-hidden rounded-2xl border border-line bg-white shadow-[0_14px_36px_rgba(23,37,58,0.07)]">
              {guideStages.map((stage, index) => (
                <li className={`grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-3.5 ${index > 0 ? "border-t border-line" : ""}`} key={stage}>
                  <span className="font-mono text-xs font-semibold text-accentText">0{index + 1}</span>
                  <span className="text-sm font-semibold text-ink">{stage}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-label="iOS setup requirements" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-paper">
          <div className="grid md:grid-cols-3">
            {requirements.map((requirement, index) => {
              const Icon = requirement.icon;
              return (
                <article className={`${index > 0 ? "border-t border-line md:border-l md:border-t-0" : ""} p-5 sm:p-6`} key={requirement.title}>
                  <Icon aria-hidden className="text-accent" size={20} />
                  <h2 className="mt-4 text-lg font-semibold text-ink">{requirement.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-muted">{requirement.text}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="grid min-w-0 gap-8 rounded-2xl border border-line bg-white p-5 sm:p-7 lg:grid-cols-[minmax(240px,0.62fr)_minmax(0,1.38fr)] lg:p-8">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">Save one URL</p>
            <h2 className="mt-3 text-2xl font-semibold leading-tight tracking-[-0.03em] text-ink sm:text-3xl">From the Share Sheet to <code className="whitespace-nowrap text-[0.86em]">/Sources</code>.</h2>
            <p className="mt-4 text-sm leading-6 text-muted">Save to KinicWiki accepts one HTTP or HTTPS URL at a time. It does not accept image or file shares.</p>
            <div className="mt-5 flex items-start gap-3 rounded-xl border border-accentLine bg-accentSoft p-4">
              <Link2 aria-hidden className="mt-0.5 shrink-0 text-accentText" size={18} />
              <p className="text-sm leading-6 text-ink">For supported X post URLs, KinicWiki also keeps available preview text and image metadata. The URL and its origin remain inspectable under <code>/Sources</code>.</p>
            </div>
          </div>

          <ol className="overflow-hidden rounded-xl border border-line bg-paper">
            {shareSteps.map((step, index) => (
              <li className={`grid gap-3 p-4 sm:grid-cols-[2.5rem_minmax(0,1fr)] sm:gap-4 sm:p-5 ${index > 0 ? "border-t border-line" : ""}`} key={step.title}>
                <span className="inline-flex size-9 items-center justify-center rounded-full border border-accentLine bg-white font-mono text-xs font-semibold text-accentText">{index + 1}</span>
                <div>
                  <h3 className="text-base font-semibold text-ink">{step.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="capture-results-heading" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-white">
          <div className="border-b border-line px-5 py-5 sm:px-7">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">Read the result</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-ink" id="capture-results-heading">What the final message means.</h2>
            <p className="mt-2 text-sm leading-6 text-muted">The message tells you whether capture is running or needs help from the main app.</p>
          </div>
          <div className="grid lg:grid-cols-3">
            {captureResults.map((result, index) => {
              const Icon = result.icon;
              return (
                <article className={`${index > 0 ? "border-t border-line lg:border-l lg:border-t-0" : ""} p-5 sm:p-6`} key={result.title}>
                  <Icon aria-hidden className="text-accent" size={20} />
                  <h3 className="mt-4 text-base font-semibold text-ink">{result.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted">{result.text}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="min-w-0 rounded-2xl border border-accentLine bg-accentSoft p-5 sm:p-7 lg:p-8">
          <div className="grid gap-7 lg:grid-cols-[minmax(230px,0.62fr)_minmax(0,1.38fr)]">
            <div>
              <div className="flex items-center gap-2">
                <RotateCcw aria-hidden className="text-accentText" size={19} />
                <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">Recover a capture</p>
              </div>
              <h2 className="mt-3 text-2xl font-semibold leading-tight tracking-[-0.03em] text-ink">If Safari cannot save immediately.</h2>
            </div>
            <div className="space-y-4 text-sm leading-6 text-ink">
              <p>If no writable database appears, return to KinicWiki, sign in again, and refresh. Confirm that the database is active, funded, and grants your principal Owner or Writer access.</p>
              <p>If the URL was saved on the device, open KinicWiki after restoring connectivity. Use Capture history to review pending requests and retry anything marked “Saved, retry required.”</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="operational-notes-heading" className="min-w-0 rounded-2xl border border-line bg-paper p-5 sm:p-7">
          <div className="max-w-[650px]">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">What stays on the device</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-ink" id="operational-notes-heading">History, language, and local data.</h2>
          </div>
          <div className="mt-6 grid gap-3 lg:grid-cols-3">
            {operationalNotes.map((note) => {
              const Icon = note.icon;
              return (
                <article className="rounded-xl border border-line bg-white p-5" key={note.title}>
                  <Icon aria-hidden className="text-accent" size={19} />
                  <h3 className="mt-4 text-base font-semibold text-ink">{note.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted">{note.text}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="flex min-w-0 flex-col justify-between gap-5 rounded-2xl border border-line bg-white p-5 sm:flex-row sm:items-center sm:p-7">
          <div className="flex items-center gap-4">
            <img className="size-12 rounded-xl" src="/ios/app-icon.webp" alt="" width={48} height={48} loading="lazy" />
            <div>
              <h2 className="text-xl font-semibold text-ink">Ready to set it up?</h2>
              <p className="mt-1 text-sm leading-6 text-muted">Install KinicWiki, then return here when you are ready to configure sharing.</p>
            </div>
          </div>
          <a className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-action bg-action px-4 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent ${focusRing}`} href={APP_STORE_URL} rel="noopener noreferrer" target="_blank">
            View on the App Store
            <ExternalLink aria-hidden size={16} />
          </a>
        </section>
      </div>
    </AdminContent>
  );
}
