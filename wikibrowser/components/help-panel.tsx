// Where: wikibrowser/components/help-panel.tsx
// What: Static in-browser help for core wiki workflows.
// Why: Users need a short reference without leaving the active database shell.

import type { ReactNode } from "react";
import { BookOpen, FileText, GitBranch, LockKeyhole, MessageSquareText, Search } from "lucide-react";

export function HelpPanel() {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-5">
      <article className="mx-auto flex max-w-4xl flex-col gap-4">
        <header className="border-b border-line pb-4">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Help</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-ink">Wiki browser help</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            Use the browser to read, search, inspect, and edit Markdown notes stored in the selected database.
          </p>
        </header>

        <section className="grid gap-3 md:grid-cols-2">
          <HelpItem
            icon={<Search aria-hidden size={17} />}
            title="Search"
            body="Path search matches node paths. Full text search matches note content and returns snippets when available."
          />
          <HelpItem
            icon={<BookOpen aria-hidden size={17} />}
            title="Browse"
            body="Use Explorer for store roots, breadcrumbs for parent folders, and Preview, Raw, or Edit for the active note."
          />
          <HelpItem
            icon={<GitBranch aria-hidden size={17} />}
            title="Links"
            body="Markdown links and wikilinks open inside the database. Graph shows local relationships around the current page."
          />
          <HelpItem
            icon={<MessageSquareText aria-hidden size={17} />}
            title="Query"
            body="The Query tab searches by default. Use ask: for an LLM answer, lint for note checks, or paste a URL to queue ingest."
          />
          <HelpItem
            icon={<FileText aria-hidden size={17} />}
            title="Sources and ingest"
            body="Sources holds raw evidence and ingest requests. Open evidence from provenance links or search when inspection is needed."
          />
          <HelpItem
            icon={<LockKeyhole aria-hidden size={17} />}
            title="Access"
            body="Public databases can be read anonymously. Internet Identity is required for private reads, URL ingest, and writer or owner edits."
          />
        </section>
      </article>
    </div>
  );
}

function HelpItem({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <section className="rounded-lg border border-line bg-paper p-4 text-sm shadow-sm">
      <div className="flex items-center gap-2">
        <span className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-white text-accent">{icon}</span>
        <h3 className="font-semibold text-ink">{title}</h3>
      </div>
      <p className="mt-3 leading-6 text-muted">{body}</p>
    </section>
  );
}
