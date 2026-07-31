import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppLink as Link } from "@/components/app-link";
import supportMarkdown from "../../docs/legal/support.md?raw";

const supportSections = Array.from(supportMarkdown.matchAll(/^##\s+(.+)$/gm), (match) => ({
  id: headingId(match[1]),
  label: match[1]
}));

export default function SupportPage() {
  return (
    <main className="min-h-screen bg-white text-ink">
      <header className="border-b border-line bg-paper px-4 py-4 sm:px-6">
        <nav className="mx-auto flex max-w-[1080px] items-center justify-between gap-4" aria-label="Primary navigation">
          <Link className="flex items-center gap-3 text-sm font-semibold text-ink no-underline" href="/">
            <img className="h-9 w-9 rounded-lg" src="/kinic-mark.png" alt="" width={36} height={36} />
            <span>Kinic Wiki</span>
          </Link>
          <Link
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold text-ink no-underline hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            href="/"
          >
            Back to Kinic Wiki
          </Link>
        </nav>
      </header>

      <div className="mx-auto grid max-w-[1080px] gap-10 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-16">
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <details className="rounded-lg border border-line bg-paper p-4 lg:hidden">
            <summary className="cursor-pointer font-mono text-xs font-semibold uppercase tracking-[0.14em] text-accentText">
              On this page · {supportSections.length} sections
            </summary>
            <nav aria-label="Support sections">
              <SupportSectionLinks columns />
            </nav>
          </details>
          <nav className="hidden rounded-lg border border-line bg-paper p-4 lg:block" aria-label="Support sections">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-accentText">On this page</p>
            <SupportSectionLinks />
          </nav>
        </aside>

        <article className="markdown-body policy-document min-w-0 max-w-[760px]">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1({ children }) {
                return (
                  <header className="mb-10 border-b-2 border-accent pb-8">
                    <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accentText">Kinic support</p>
                    <h1 className="mt-3 text-4xl font-semibold leading-tight text-ink sm:text-5xl">{children}</h1>
                  </header>
                );
              },
              h2({ children }) {
                const id = headingId(plainText(children));
                return (
                  <h2 className="scroll-mt-8 border-t border-line pt-8" id={id}>
                    {children}
                  </h2>
                );
              },
              ul({ children, ...props }) {
                return <ul className="list-disc pl-6" {...props}>{children}</ul>;
              },
              ol({ children, ...props }) {
                return <ol className="list-decimal pl-6" {...props}>{children}</ol>;
              },
              a({ href, children, ...props }) {
                const external = href?.startsWith("http://") || href?.startsWith("https://");
                return (
                  <a
                    href={href}
                    rel={external ? "noreferrer noopener" : undefined}
                    target={external ? "_blank" : undefined}
                    {...props}
                  >
                    {children}
                  </a>
                );
              }
            }}
          >
            {supportMarkdown}
          </ReactMarkdown>
        </article>
      </div>

      <footer className="border-t border-line bg-paper px-4 py-6 text-center text-xs text-muted sm:px-6">
        Kinic Wiki · Support
      </footer>
    </main>
  );
}

function headingId(value: string): string {
  return value
    .replace(/^\d+\.\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function plainText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(plainText).join("");
  return "";
}

function SupportSectionLinks({ columns = false }: { columns?: boolean }) {
  return (
    <ol className={`mt-4 grid gap-2 text-sm ${columns ? "sm:grid-cols-2" : ""}`}>
      {supportSections.map((section) => (
        <li key={section.id}>
          <a
            className="block rounded-md px-2 py-1.5 leading-5 text-muted no-underline hover:bg-white hover:text-accentText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            href={`#${section.id}`}
          >
            {section.label}
          </a>
        </li>
      ))}
    </ol>
  );
}
