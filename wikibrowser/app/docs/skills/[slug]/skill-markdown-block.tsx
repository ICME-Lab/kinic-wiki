"use client";

import { useState } from "react";
import { Check, Copy, FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AdminPanel } from "@/components/admin-ui";
import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";
import type { SkillMarkdownReference } from "../../skill-markdown";

export function SkillMarkdownBlock({ markdown, references }: { markdown: string; references: SkillMarkdownReference[] }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const frontmatter = splitMarkdownFrontmatter(markdown);
  const renderedMarkdown = frontmatter?.body ?? markdown;

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1400);
  }

  const copied = copyState === "copied";
  const copyLabel = copied ? "SKILL.md copied" : copyState === "failed" ? "SKILL.md copy failed" : "Copy SKILL.md";
  const copyText = copied ? "Copied" : copyState === "failed" ? "Try again" : "Copy";

  return (
    <AdminPanel className="min-w-0" padding="lg">
      <div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <FileText aria-hidden className="text-accent" size={18} />
            <h2 className="text-lg font-semibold text-ink">SKILL.md</h2>
          </div>
          <div className="flex items-center gap-2">
            <fieldset aria-label="SKILL.md view" className="flex h-10 flex-1 items-center rounded-lg border border-line bg-canvas p-1 sm:flex-none">
              {(["rendered", "raw"] as const).map((option) => {
                const active = view === option;
                return (
                  <button
                    aria-pressed={active}
                    className={`h-8 flex-1 rounded-md px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 sm:flex-none ${active ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"}`}
                    key={option}
                    type="button"
                    onClick={() => setView(option)}
                  >
                    {option === "rendered" ? "Rendered" : "Raw"}
                  </button>
                );
              })}
            </fieldset>
            <button
              aria-label={copyLabel}
              className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs font-semibold shadow-[0_4px_10px_#14142b0a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${copied ? "border-green-200 bg-green-50 text-green-800" : "border-line bg-white text-muted hover:border-accent hover:text-accentText"}`}
              title={copyLabel}
              type="button"
              onClick={() => void copyMarkdown()}
            >
              {copied ? <Check aria-hidden size={15} /> : <Copy aria-hidden size={15} />}
              <span>{copyText}</span>
            </button>
          </div>
        </div>
        <p className="mt-3 text-sm leading-6 text-muted">Read the skill as documentation or switch to the exact source.</p>

        {view === "rendered" ? (
          <section aria-label="Rendered SKILL.md" className="mt-4">
            {frontmatter && frontmatter.fields.length > 0 ? (
              <div className="mb-4 rounded-lg border border-line bg-canvas p-4">
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-accentText">Frontmatter</p>
                <dl className="mt-3 grid gap-3">
                  {frontmatter.fields.map((field, index) => (
                    <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4" key={`${field.key}-${index}`}>
                      <dt className="font-mono text-xs font-semibold text-muted">{field.key}</dt>
                      <dd className="min-w-0 break-words text-sm leading-6 text-ink">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
            <article className="markdown-body min-w-0 rounded-lg border border-line bg-white px-5 py-6 text-sm text-ink sm:px-7">
              <SkillMarkdownDocument markdown={renderedMarkdown} references={references} />
            </article>
            {references.map((reference) => (
              <section aria-label={`Reference ${reference.href}`} className="mt-6" id={referenceAnchorId(reference.href)} key={reference.href}>
                <article className="markdown-body min-w-0 rounded-lg border border-line bg-white px-5 py-6 text-sm text-ink sm:px-7">
                  <SkillMarkdownDocument markdown={reference.markdown} references={[]} />
                </article>
              </section>
            ))}
          </section>
        ) : null}

        {view === "raw" ? (
          <section aria-label="Raw SKILL.md" className="mt-4">
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-4 text-xs leading-6 text-ink lg:max-h-[48rem] lg:overflow-y-auto"><code>{markdown}</code></pre>
          </section>
        ) : null}
      </div>
    </AdminPanel>
  );
}

function SkillMarkdownDocument({ markdown, references }: { markdown: string; references: SkillMarkdownReference[] }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1({ children }) {
          return <h3 className="mt-0 text-xl font-semibold text-ink">{children}</h3>;
        },
        h2({ children }) {
          return <h4 className="mt-8 text-base font-semibold text-ink">{children}</h4>;
        },
        h3({ children }) {
          return <h5 className="mt-6 text-sm font-semibold text-ink">{children}</h5>;
        },
        ul({ children, ...props }) {
          return <ul className="list-disc" {...props}>{children}</ul>;
        },
        ol({ children, ...props }) {
          return <ol className="list-decimal" {...props}>{children}</ol>;
        },
        a({ children, href }) {
          if (href?.startsWith("https://")) return <a href={href} rel="noreferrer noopener" target="_blank">{children}</a>;
          const reference = references.find((entry) => entry.href === href);
          return reference ? <a href={`#${referenceAnchorId(reference.href)}`}>{children}</a> : <span className="font-medium text-accentText">{children}</span>;
        }
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function referenceAnchorId(href: string): string {
  return `skill-reference-${href.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}
