// Where: /docs/ios.
// What: guides iPhone and iPad users from installation through capture, browsing, and Ask AI.
// Why: the public iOS product page should stay concise while setup and failure recovery remain discoverable.
import { AppLink as Link } from "@/components/app-link";
import { AdminContent } from "@/components/admin-shell";
import { AdminNotice, AdminPanel } from "@/components/admin-ui";
import { CheckCircle2, Clock3, Database, ExternalLink, FolderSearch, KeyRound, Languages, Link2, RotateCcw, Settings2, Share2, ShieldCheck, Smartphone, Sparkles } from "lucide-react";

const APP_STORE_URL = "https://apps.apple.com/us/app/kinicwiki-ai-memory/id6785718977";

export const metadata: Record<string, unknown> = {
  title: "KinicWiki iOS Setup Guide",
  description: "Use the KinicWiki Share Extension to save Safari pages and X posts under /Sources, then review, retry, browse, and ask with cited notes.",
  openGraph: {
    title: "KinicWiki iOS Setup Guide",
    description: "Set up the KinicWiki Share Extension for Safari and X, save web URLs under /Sources, and recover captures that need a retry."
  },
  twitter: {
    title: "KinicWiki iOS Setup Guide",
    description: "Set up the KinicWiki Share Extension for Safari and X, save web URLs under /Sources, and recover captures that need a retry."
  }
};

const requirements = [
  {
    icon: Smartphone,
    title: "iOS 18 or later",
    text: "KinicWiki supports iPhone and iPad devices running iOS or iPadOS 18 and later."
  },
  {
    icon: KeyRound,
    title: "Internet Identity",
    text: "Use Internet Identity to open the databases attached to your Kinic Wiki principal."
  },
  {
    icon: Database,
    title: "A usable database",
    text: "Capture needs an active Owner or Writer database with enough write cycles. Reader access is enough for Browse."
  }
];

const setupSteps = [
  {
    title: "Browse your memory",
    text: "Open Browse to search and read visible databases, including Reader databases. Inspect /Sources for evidence and /Knowledge for maintained notes."
  },
  {
    title: "Ask one database",
    text: "Open Ask AI, select a database, and ask a question. When the answer needs stored facts, Kinic AI searches that database and shows the supporting notes."
  },
  {
    title: "Adjust Settings",
    text: "Set Output Language for new captures and Ask AI answers, choose Dark Mode, and control whether public and purchased databases appear in Browse."
  }
];

const shareSteps = [
  {
    title: "Prepare KinicWiki once",
    text: "Open the app, sign in with Internet Identity, and make sure you have an active database where you are an Owner or Writer."
  },
  {
    title: "Open Save to KinicWiki",
    text: "From a Safari page or an X post, open the Share Sheet and choose Save to KinicWiki. If it is not visible, add it using the Share Sheet's app customization."
  },
  {
    title: "Choose where the URL belongs",
    text: "Select a writable database and tap Save. The Share Extension remembers that destination but still shows it before the next save."
  },
  {
    title: "Review the generated source",
    text: "KinicWiki starts processing the page and its origin. Open Capture history to follow its status, then open the finished evidence under /Sources."
  }
];

const captureResults = [
  {
    icon: CheckCircle2,
    title: "Capture started",
    text: "The request was saved and KinicWiki started generating the source capture. You can close the Share Sheet."
  },
  {
    icon: Clock3,
    title: "Saved for later",
    text: "The URL is safe in an on-device queue. Open KinicWiki after signing in or restoring connectivity so the app can submit it."
  },
  {
    icon: RotateCcw,
    title: "Saved, retry required",
    text: "The request reached your database, but processing did not start. Open Capture history in KinicWiki and retry it."
  }
];

const experiences = [
  {
    eyebrow: "CAPTURE",
    title: "Save from Safari or X",
    text: "Choose a writable destination for one shared web URL without leaving the Share Sheet.",
    image: "/ios/save-from-safari.webp",
    alt: "KinicWiki Share Extension choosing a database and saving a Safari page"
  },
  {
    eyebrow: "BROWSE",
    title: "Inspect the stored wiki",
    text: "Move between Sources, Knowledge, Memory, Sessions, and Skills, then search within the database.",
    image: "/ios/browse-knowledge.webp",
    alt: "KinicWiki Browse screen showing the database knowledge stores"
  },
  {
    eyebrow: "ASK",
    title: "Open the cited notes",
    text: "See how an answer was found and inspect the database document behind it.",
    image: "/ios/ask-with-sources.webp",
    alt: "KinicWiki Ask AI answer with a visible cited source document"
  }
];

export default function IOSGuidePage() {
  return (
    <AdminContent>
      <div className="flex flex-col gap-6">
        <AdminPanel className="min-w-0 overflow-hidden" padding="lg">
          <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.58fr)] lg:items-center">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <img className="size-14 rounded-2xl shadow-[0_10px_28px_rgba(0,0,0,0.12)]" src="/ios/app-icon.webp" alt="KinicWiki app icon" width={56} height={56} />
                <div>
                  <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-accentText">iPhone + iPad</p>
                  <p className="mt-1 text-sm text-muted">Getting started</p>
                </div>
              </div>
              <h1 className="mt-5 max-w-[720px] text-3xl font-semibold leading-tight tracking-[-0.035em] text-ink sm:text-4xl">Save from Safari or X with the Share Extension</h1>
              <p className="mt-4 max-w-3xl text-sm leading-6 text-muted">
                Share one web URL, choose the Kinic Wiki database where it belongs, and keep the generated evidence under /Sources. Browse it later or ask questions with the source notes attached.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <a className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-action bg-action px-4 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href={APP_STORE_URL} rel="noopener noreferrer" target="_blank">
                  Download on the App Store
                  <ExternalLink aria-hidden size={16} />
                </a>
                <Link className="inline-flex min-h-11 items-center justify-center rounded-lg border border-line bg-white px-4 text-sm font-bold text-ink no-underline hover:border-accent hover:bg-accentSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href="/ios">
                  See the app overview
                </Link>
              </div>
            </div>
            <div className="mx-auto w-full max-w-[290px] overflow-hidden rounded-[2.2rem] border-[7px] border-black bg-white shadow-[0_22px_55px_rgba(0,0,0,0.16)] lg:mr-0">
              <img className="block h-auto w-full" src="/ios/save-from-safari.webp" alt="Save to KinicWiki Share Extension selecting a destination database for a Safari page" width={720} height={1440} />
            </div>
          </div>
        </AdminPanel>

        <AdminPanel ariaLabel="iOS setup requirements" className="min-w-0 overflow-hidden" padding="none">
          <div className="grid md:grid-cols-3">
            {requirements.map((requirement, index) => {
              const Icon = requirement.icon;
              return (
                <article className={`${index > 0 ? "border-t border-line md:border-l md:border-t-0" : ""} p-5`} key={requirement.title}>
                  <Icon aria-hidden className="text-accent" size={20} />
                  <h2 className="mt-4 text-lg font-semibold text-ink">{requirement.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-muted">{requirement.text}</p>
                </article>
              );
            })}
          </div>
        </AdminPanel>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
            <section>
              <div className="flex items-center gap-2">
                <Share2 aria-hidden className="text-accent" size={19} />
                <h2 className="text-xl font-semibold text-ink">Save from Safari or X</h2>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted">
                Save to KinicWiki accepts one HTTP or HTTPS URL at a time. It does not accept image or file shares. For supported X post URLs, KinicWiki also keeps available preview text and image metadata when X exposes them.
              </p>
              <div className="mt-4 flex items-start gap-3 rounded-lg border border-accentLine bg-accentSoft p-4">
                <Link2 aria-hidden className="mt-0.5 shrink-0 text-accentText" size={18} />
                <p className="text-sm leading-6 text-ink">The shared URL and its origin remain inspectable in the source generated under <code>/Sources</code>.</p>
              </div>
            </section>
            <ol className="overflow-hidden rounded-lg border border-line bg-white">
              {shareSteps.map((step, index) => (
                <li className={`grid gap-3 p-4 sm:grid-cols-[2.25rem_minmax(0,1fr)] sm:gap-4 ${index > 0 ? "border-t border-line" : ""}`} key={step.title}>
                  <span className="inline-flex size-8 items-center justify-center rounded-full bg-accentSoft font-mono text-xs font-semibold text-accentText">{index + 1}</span>
                  <div>
                    <h3 className="text-base font-semibold text-ink">{step.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-muted">{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </AdminPanel>

        <AdminPanel ariaLabel="Share Extension capture results" className="min-w-0 overflow-hidden" padding="none">
          <div className="border-b border-line p-5">
            <h2 className="text-xl font-semibold text-ink">What the Share Extension result means</h2>
            <p className="mt-2 text-sm leading-6 text-muted">The final message tells you whether capture is running or needs help from the main app.</p>
          </div>
          <div className="grid lg:grid-cols-3">
            {captureResults.map((result, index) => {
              const Icon = result.icon;
              return (
                <article className={`${index > 0 ? "border-t border-line lg:border-l lg:border-t-0" : ""} p-5`} key={result.title}>
                  <Icon aria-hidden className="text-accent" size={20} />
                  <h3 className="mt-4 text-base font-semibold text-ink">{result.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted">{result.text}</p>
                </article>
              );
            })}
          </div>
        </AdminPanel>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <Smartphone aria-hidden className="text-accent" size={19} />
            <h2 className="text-xl font-semibold text-ink">Continue from capture to your first cited answer</h2>
          </div>
          <ol className="mt-5 overflow-hidden rounded-lg border border-line bg-white">
            {setupSteps.map((step, index) => (
              <li className={`grid gap-3 p-4 sm:grid-cols-[2.25rem_minmax(0,1fr)] sm:gap-4 ${index > 0 ? "border-t border-line" : ""}`} key={step.title}>
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-accentSoft font-mono text-xs font-semibold text-accentText">{index + 1}</span>
                <div>
                  <h3 className="text-base font-semibold text-ink">{step.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </AdminPanel>

        <section className="grid gap-4 xl:grid-cols-3" aria-label="KinicWiki iOS workflows">
          {experiences.map((experience) => (
            <article className="min-w-0 overflow-hidden rounded-lg border border-line bg-paper shadow-sm" key={experience.title}>
              <div className="p-5">
                <p className="font-mono text-xs font-semibold text-accentText">{experience.eyebrow}</p>
                <h2 className="mt-2 text-lg font-semibold text-ink">{experience.title}</h2>
                <p className="mt-2 text-sm leading-6 text-muted">{experience.text}</p>
              </div>
              <div className="border-t border-line bg-[#f8f8f8] p-5">
                <div className="mx-auto max-w-[260px] overflow-hidden rounded-[1.7rem] border-[5px] border-black bg-white shadow-[0_14px_34px_rgba(0,0,0,0.13)]">
                  <img className="block h-auto w-full" src={experience.image} alt={experience.alt} width={720} height={1440} loading="lazy" />
                </div>
              </div>
            </article>
          ))}
        </section>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <div className="flex items-center gap-2">
                <Share2 aria-hidden className="text-accent" size={19} />
                <h2 className="text-xl font-semibold text-ink">If Safari cannot save immediately</h2>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted">
                The Share Extension first tries to write directly. If immediate submission is unavailable, it keeps the URL in an on-device queue so KinicWiki can retry after the app opens. If no writable database appears, refresh after signing in and confirm that the database is active and funded. Capture history shows requests that are still processing or need a manual retry.
              </p>
              <div className="mt-4">
                <AdminNotice tone="info" message="Capture requires an Owner or Writer database with enough write cycles. Browse can also show databases where your principal has Reader access." />
              </div>
            </section>
            <section>
              <div className="flex items-center gap-2">
                <Sparkles aria-hidden className="text-accent" size={19} />
                <h2 className="text-xl font-semibold text-ink">How Ask AI uses your database</h2>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted">
                Ask AI is scoped to the database you select. It can answer conversational requests directly, but questions that require stored facts use database search and show supporting notes. When no supporting document is available, KinicWiki does not produce a grounded answer.
              </p>
              <div className="mt-4 flex items-start gap-3 rounded-lg border border-infoLine bg-infoSoft p-4">
                <FolderSearch aria-hidden className="mt-0.5 shrink-0 text-infoText" size={18} />
                <p className="text-sm leading-6 text-ink">Open “How this answer was found” to inspect search activity and the cited documents.</p>
              </div>
            </section>
          </div>
        </AdminPanel>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <div className="flex items-center gap-2">
                <Settings2 aria-hidden className="text-accent" size={19} />
                <h2 className="text-xl font-semibold text-ink">Settings and local data</h2>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted">Settings apply to the next capture or question without changing content that is already queued or stored.</p>
            </div>
            <div className="grid gap-3">
              <SettingRow icon={Languages} title="Output Language" text="New captures and Ask AI answers use the selected language unless the current question explicitly requests another answer language." />
              <SettingRow icon={Smartphone} title="Appearance and Browse" text="Choose Dark Mode and whether public or purchased databases appear in Browse." />
              <SettingRow icon={ShieldCheck} title="History and request privacy" text="Ask AI history is stored on this device in separate namespaces for each signed-in principal. Generation request data is discarded after processing." />
            </div>
          </div>
        </AdminPanel>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-xl font-semibold text-ink">Ready to use your wiki on iOS?</h2>
              <p className="mt-2 text-sm leading-6 text-muted">Install KinicWiki, then sign in with the Internet Identity that owns or can access your database.</p>
            </div>
            <a className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-action bg-action px-4 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href={APP_STORE_URL} rel="noopener noreferrer" target="_blank">
              View on the App Store
            </a>
          </div>
        </AdminPanel>
      </div>
    </AdminContent>
  );
}

function SettingRow({ icon: Icon, text, title }: { icon: typeof Languages; text: string; title: string }) {
  return (
    <article className="grid gap-3 rounded-lg border border-line bg-white p-4 sm:grid-cols-[2rem_minmax(0,1fr)]">
      <Icon aria-hidden className="text-accent" size={18} />
      <div>
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-sm leading-6 text-muted">{text}</p>
      </div>
    </article>
  );
}
