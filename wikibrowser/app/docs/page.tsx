// Where: /docs index.
// What: provides the top-level documentation landing page.
// Why: CLI, Canister API, and Skills docs need one stable operator entrypoint.
import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen, Boxes, ExternalLink, FileText } from "lucide-react";
import { AdminContent } from "@/components/admin-shell";
import { AdminPanel } from "@/components/admin-ui";
import { primaryDocs, skillDocs } from "./docs-data";

export const metadata: Metadata = {
  title: "Kinic Wiki Docs",
  description: "Documentation for Kinic Wiki CLI, Canister API, and agent skill workflows.",
  openGraph: {
    title: "Kinic Wiki Docs",
    description: "Documentation for Kinic Wiki CLI, Canister API, and agent skill workflows."
  },
  twitter: {
    title: "Kinic Wiki Docs",
    description: "Documentation for Kinic Wiki CLI, Canister API, and agent skill workflows."
  }
};

export default function DocsPage() {
  return (
    <AdminContent>
      <div className="flex flex-col gap-6">
        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <BookOpen aria-hidden className="text-accent" size={20} />
            <p className="text-sm font-semibold uppercase text-accentText">Docs</p>
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-ink">Kinic Wiki documentation</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
            Operator references for the CLI, direct canister calls, and agent workflow skills. Use these pages when wiring automation or reviewing how wiki memory should be read, edited, and audited.
          </p>
        </AdminPanel>

        <section className="grid gap-4 md:grid-cols-3" aria-label="Primary docs">
          {primaryDocs.map((doc) => (
            <Link className="group rounded-lg border border-line bg-paper p-4 text-ink no-underline shadow-sm hover:border-accent hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href={doc.href} key={doc.href}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <FileText aria-hidden className="text-accent" size={18} />
                  <h2 className="text-lg font-semibold">{doc.title}</h2>
                </div>
                <ExternalLink aria-hidden className="shrink-0 text-muted group-hover:text-accentText" size={16} />
              </div>
              <p className="mt-3 text-sm leading-6 text-muted">{doc.description}</p>
            </Link>
          ))}
        </section>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <Boxes aria-hidden className="text-accent" size={18} />
            <h2 className="text-lg font-semibold text-ink">Skill workflows</h2>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {skillDocs.map((doc) => (
              <Link className="rounded-lg border border-line bg-white p-3 text-ink no-underline hover:border-accent hover:bg-accentSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href={doc.href} key={doc.href}>
                <p className="text-xs font-semibold uppercase text-muted">{doc.eyebrow}</p>
                <h3 className="mt-1 text-base font-semibold">{doc.title}</h3>
                <p className="mt-2 text-sm leading-5 text-muted">{doc.description}</p>
              </Link>
            ))}
          </div>
        </AdminPanel>
      </div>
    </AdminContent>
  );
}
