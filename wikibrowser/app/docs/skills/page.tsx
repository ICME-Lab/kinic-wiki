// Where: /docs/skills overview.
// What: introduces agent workflow skill docs.
// Why: skills are documentation workflows here, separate from the Skill Registry management UI.
import type { Metadata } from "next";
import Link from "next/link";
import { Boxes, ExternalLink, ShieldCheck } from "lucide-react";
import { AdminContent } from "@/components/admin-shell";
import { AdminPanel } from "@/components/admin-ui";
import { skillDocs } from "../docs-data";

export const metadata: Metadata = {
  title: "Kinic Wiki Skills Docs",
  description: "Agent workflow skills for querying, editing, ingesting, linting, exporting, and managing Skill Registry packages.",
  openGraph: {
    title: "Kinic Wiki Skills Docs",
    description: "Agent workflow skills for querying, editing, ingesting, linting, exporting, and managing Skill Registry packages."
  },
  twitter: {
    title: "Kinic Wiki Skills Docs",
    description: "Agent workflow skills for querying, editing, ingesting, linting, exporting, and managing Skill Registry packages."
  }
};

export default function SkillsDocsPage() {
  return (
    <AdminContent>
      <div className="flex flex-col gap-6">
        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <Boxes aria-hidden className="text-accent" size={20} />
            <p className="text-sm font-semibold uppercase text-accentText">Skills</p>
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-ink">Agent workflow skills</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
            These docs describe how agents should use Kinic Wiki workflows. The Skill Registry management UI remains at database-specific <code>/skills/&lt;database-id&gt;</code> routes.
          </p>
        </AdminPanel>

        <section className="grid gap-4 md:grid-cols-2" aria-label="Skill workflow docs">
          {skillDocs.map((doc) => (
            <Link className="group rounded-lg border border-line bg-paper p-4 text-ink no-underline shadow-sm hover:border-accent hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href={doc.href} key={doc.href}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-muted">{doc.eyebrow}</p>
                  <h2 className="mt-1 text-lg font-semibold">{doc.title}</h2>
                </div>
                <ExternalLink aria-hidden className="shrink-0 text-muted group-hover:text-accentText" size={16} />
              </div>
              <p className="mt-3 text-sm leading-6 text-muted">{doc.summary}</p>
            </Link>
          ))}
        </section>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden className="text-accent" size={18} />
            <h2 className="text-lg font-semibold text-ink">Shared rules</h2>
          </div>
          <ul className="mt-4 grid gap-2 text-sm leading-6 text-muted md:grid-cols-2">
            <li>Read exact evidence before presenting an answer.</li>
            <li>Keep organized knowledge under <code>/Knowledge</code> and raw evidence under <code>/Sources</code>.</li>
            <li>Use etag guards for edits to existing nodes.</li>
            <li>Do not add compatibility shims or fallback branches for old structures.</li>
          </ul>
        </AdminPanel>
      </div>
    </AdminContent>
  );
}
