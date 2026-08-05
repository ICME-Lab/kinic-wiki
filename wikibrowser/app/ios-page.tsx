// Where: wikibrowser/app/ios-page.tsx
// What: Public introduction page for the KinicWiki iPhone and iPad app.
// Why: Mobile visitors need a clear path from product value to the App Store.
import { AppLink as Link } from "@/components/app-link";

const APP_STORE_URL = "https://apps.apple.com/us/app/kinicwiki-ai-memory/id6785718977";

const experiences = [
  {
    eyebrow: "Save from Safari",
    title: "Keep the page before you lose the context.",
    description: "Share any web page to KinicWiki, choose a writable database, and save the source without leaving Safari.",
    path: "/Sources",
    image: "/ios/save-from-safari.webp",
    imageAlt: "KinicWiki share extension saving a Safari page to Personal Memory"
  },
  {
    eyebrow: "Browse your wiki",
    title: "Move from raw sources to useful knowledge.",
    description: "Search and read Sources, Knowledge, Memory, Sessions, and Skills across the databases you choose.",
    path: "/Knowledge",
    image: "/ios/browse-knowledge.webp",
    imageAlt: "KinicWiki Browse screen showing Sources, Knowledge, Memory, Sessions, and Skills"
  },
  {
    eyebrow: "Ask with evidence",
    title: "See the notes behind every supported answer.",
    description: "Ask one selected database a question, then inspect the documents Kinic AI searched and cited.",
    path: "cited answer",
    image: "/ios/ask-with-sources.webp",
    imageAlt: "KinicWiki Ask AI screen showing an answer and its cited source document"
  }
];

const trustPoints = [
  {
    label: "Your identity",
    text: "Sign in with Internet Identity instead of creating another password."
  },
  {
    label: "Your wiki",
    text: "Your notes live in the Kinic Wiki database you select on the Internet Computer."
  },
  {
    label: "Your conversations",
    text: "Ask AI history stays on your device, and request data is discarded after processing."
  }
];

const linkFocus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

export default function IOSPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-white text-ink">
      <header className="border-b border-line bg-paper px-4 py-4 sm:px-6">
        <nav className="mx-auto flex max-w-[1080px] flex-wrap items-center justify-between gap-3" aria-label="Primary navigation">
          <Link className={`flex items-center gap-3 text-sm font-semibold text-ink no-underline ${linkFocus}`} href="/">
            <img className="h-10 w-10 rounded-lg" src="/kinic-mark.png" alt="" width={40} height={40} />
            <span>Kinic Wiki</span>
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <Link className={`rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold text-ink no-underline hover:border-accent hover:text-accent ${linkFocus}`} href="/docs/cli">
              CLI
            </Link>
            <Link className={`rounded-lg border border-action bg-action px-3 py-2 text-sm font-semibold text-white no-underline hover:border-accent hover:bg-accent ${linkFocus}`} href="/dashboard">
              Dashboard
            </Link>
          </div>
        </nav>
      </header>

      <section className="relative border-b border-line px-4 py-14 sm:px-6 sm:py-20">
        <div className="absolute inset-y-0 right-0 -z-10 hidden w-[46%] bg-paper lg:block" />
        <div className="mx-auto grid max-w-[1080px] gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)] lg:items-center">
          <div>
            <div className="flex items-center gap-4">
              <img className="h-16 w-16 rounded-[18px] shadow-[0_12px_30px_rgba(23,37,58,0.16)] sm:h-20 sm:w-20" src="/ios/app-icon.webp" alt="KinicWiki app icon" width={80} height={80} />
              <div>
                <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">KinicWiki: AI Memory</p>
                <p className="mt-1 text-sm text-muted">For iPhone and iPad</p>
              </div>
            </div>
            <h1 className="mt-8 max-w-[700px] text-4xl font-semibold leading-[1.04] tracking-[-0.045em] text-ink sm:text-6xl">Your AI memory, on iPhone and iPad.</h1>
            <p className="mt-6 max-w-[610px] text-lg leading-8 text-muted">
              Save useful pages from Safari, browse the knowledge you keep, and ask questions with the source notes still attached.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <a
                className={`inline-flex min-h-12 items-center gap-3 rounded-xl border border-action bg-action px-5 py-3 text-sm font-bold text-white no-underline transition-colors hover:border-accent hover:bg-accent ${linkFocus}`}
                href={APP_STORE_URL}
                rel="noreferrer noopener"
                target="_blank"
              >
                <AppleMark />
                Download on the App Store
              </a>
              <a className={`text-sm font-semibold text-muted underline decoration-line underline-offset-4 hover:text-accentText ${linkFocus}`} href="#how-it-works">
                See how it works
              </a>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-[360px] lg:mr-0">
            <div className="absolute -left-10 top-[18%] h-36 w-36 rounded-full border border-accentLine bg-accentSoft" />
            <div className="absolute -right-12 bottom-[12%] h-24 w-24 rounded-full border border-line bg-white" />
            <div className="relative overflow-hidden rounded-[2.6rem] border-[8px] border-[#17253a] bg-white shadow-[0_24px_70px_rgba(23,37,58,0.20)]">
              <img className="block h-auto w-full" src="/ios/ask-with-sources.webp" alt="KinicWiki Ask AI answer with a visible cited source" width={720} height={1440} />
            </div>
          </div>
        </div>
      </section>

      <section className="bg-paper px-4 py-16 sm:px-6 sm:py-20" id="how-it-works">
        <div className="mx-auto max-w-[1080px]">
          <div className="max-w-[680px]">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">One continuous memory</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-[-0.035em] text-ink sm:text-4xl">Capture the source. Keep the knowledge. Check the answer.</h2>
          </div>

          <div className="relative mt-12">
            <div className="absolute bottom-8 left-[19px] top-8 w-px bg-accentLine lg:bottom-auto lg:left-[16.66%] lg:right-[16.66%] lg:top-[19px] lg:h-px lg:w-auto" aria-hidden="true" />
            <ol className="relative grid gap-8 lg:grid-cols-3 lg:gap-5">
              {experiences.map((experience) => (
                <li className="relative grid grid-cols-[40px_minmax(0,1fr)] gap-4 lg:block" key={experience.path}>
                  <div className="relative z-10 grid h-10 w-10 place-items-center rounded-full border border-accentLine bg-white font-mono text-[10px] font-semibold text-accentText lg:mx-auto">
                    <span className="h-2 w-2 rounded-full bg-accent" />
                  </div>
                  <article className="min-w-0 overflow-hidden rounded-2xl border border-line bg-white shadow-[0_14px_40px_rgba(0,0,0,0.05)] lg:mt-6">
                    <div className="border-b border-line px-5 py-5">
                      <p className="font-mono text-[11px] font-semibold text-accentText">{experience.path}</p>
                      <p className="mt-3 text-xs font-bold uppercase tracking-[0.12em] text-muted">{experience.eyebrow}</p>
                      <h3 className="mt-2 text-xl font-semibold leading-tight tracking-[-0.025em] text-ink">{experience.title}</h3>
                      <p className="mt-3 text-sm leading-6 text-muted">{experience.description}</p>
                    </div>
                    <div className="bg-[#f1f3f7] p-4 sm:p-6 lg:p-4">
                      <div className="mx-auto max-w-[260px] overflow-hidden rounded-[1.8rem] border-[5px] border-[#17253a] bg-white shadow-[0_16px_34px_rgba(23,37,58,0.15)]">
                        <img className="block h-auto w-full" src={experience.image} alt={experience.imageAlt} width={720} height={1440} loading="lazy" />
                      </div>
                    </div>
                  </article>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-white px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto grid max-w-[1080px] gap-10 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:items-start">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">Built for your memory</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-[-0.035em] text-ink sm:text-4xl">Know where your data lives.</h2>
            <p className="mt-5 max-w-[480px] text-base leading-7 text-muted">
              KinicWiki keeps the database you choose at the center. Identity, storage, and AI processing each have a clear role.
            </p>
            <Link className={`mt-6 inline-flex text-sm font-semibold text-accentText underline decoration-accentLine underline-offset-4 hover:text-ink ${linkFocus}`} href="/privacy-policy">
              Read the Privacy Policy
            </Link>
          </div>
          <div className="divide-y divide-line rounded-2xl border border-line bg-paper">
            {trustPoints.map((point) => (
              <article className="grid gap-2 px-5 py-5 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-6 sm:px-6" key={point.label}>
                <h3 className="text-sm font-semibold text-ink">{point.label}</h3>
                <p className="text-sm leading-6 text-muted">{point.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-paper px-4 py-14 sm:px-6">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-6 rounded-2xl border border-line bg-white px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex items-center gap-4">
            <img className="h-14 w-14 rounded-2xl" src="/ios/app-icon.webp" alt="" width={56} height={56} loading="lazy" />
            <div>
              <h2 className="text-xl font-semibold text-ink">Take your wiki with you.</h2>
              <p className="mt-1 text-sm text-muted">KinicWiki: AI Memory for iPhone and iPad.</p>
            </div>
          </div>
          <a className={`inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-action bg-action px-5 py-3 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent ${linkFocus}`} href={APP_STORE_URL} rel="noreferrer noopener" target="_blank">
            View on the App Store
          </a>
        </div>
      </section>

      <footer className="border-t border-line bg-white px-4 py-6 text-sm text-muted sm:px-6">
        <nav className="mx-auto flex max-w-[1080px] flex-wrap items-center justify-between gap-3" aria-label="Footer navigation">
          <span>Kinic Wiki</span>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Link className={`text-muted underline-offset-4 hover:text-accent hover:underline ${linkFocus}`} href="/support">Support</Link>
            <Link className={`text-muted underline-offset-4 hover:text-accent hover:underline ${linkFocus}`} href="/privacy-policy">Privacy Policy</Link>
          </div>
        </nav>
      </footer>
    </main>
  );
}

function AppleMark() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.05 12.54c-.02-2.16 1.77-3.21 1.85-3.26-1.01-1.48-2.59-1.68-3.15-1.7-1.33-.14-2.62.8-3.29.8-.68 0-1.71-.78-2.82-.76-1.43.02-2.77.85-3.51 2.14-1.53 2.64-.39 6.52 1.08 8.65.74 1.06 1.6 2.24 2.71 2.2 1.09-.05 1.5-.71 2.82-.71 1.3 0 1.69.71 2.83.68 1.17-.02 1.9-1.06 2.61-2.12.85-1.22 1.19-2.42 1.2-2.48-.03-.01-2.31-.9-2.33-3.44ZM14.88 6.17a3.9 3.9 0 0 0 .89-2.79 3.96 3.96 0 0 0-2.57 1.33 3.7 3.7 0 0 0-.92 2.68 3.28 3.28 0 0 0 2.6-1.22Z" />
    </svg>
  );
}
