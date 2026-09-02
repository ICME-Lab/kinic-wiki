// Where: /docs/skills/[slug].
// What: renders one documented agent workflow skill.
// Why: skill docs need stable, deep-linkable pages without touching the Skill Registry UI.
import { AppLink as Link } from "@/components/app-link";
import { notFound } from "@tanstack/react-router";
import { ArrowLeft, Workflow } from "lucide-react";
import { AdminContent } from "@/components/admin-shell";
import { AdminPanel } from "@/components/admin-ui";
import { findSkillDoc } from "../../docs-data";
import { findSkillMarkdown, findSkillMarkdownReferences } from "../../skill-markdown";
import { SkillMarkdownBlock } from "./skill-markdown-block";

type SkillDocPageProps = { slug: string };

export default function SkillDocPage({ slug }: SkillDocPageProps) {
  const doc = findSkillDoc(slug);
  const skillMarkdown = findSkillMarkdown(slug);
  const skillMarkdownReferences = findSkillMarkdownReferences(slug);
  if (!doc || !skillMarkdown) throw notFound();

  return (
    <AdminContent>
      <div className="flex flex-col gap-6">
        <AdminPanel className="min-w-0" padding="lg">
          <Link className="inline-flex items-center gap-2 text-sm font-semibold text-muted no-underline hover:text-accentText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href="/docs/skills">
            <ArrowLeft aria-hidden size={16} />
            <span>Skills</span>
          </Link>
          <div className="mt-5 flex items-center gap-2">
            <Workflow aria-hidden className="text-accent" size={20} />
            <p className="text-sm font-semibold uppercase text-accentText">{doc.eyebrow}</p>
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-ink">{doc.title}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">{doc.summary}</p>
        </AdminPanel>
        <SkillMarkdownBlock markdown={skillMarkdown} references={skillMarkdownReferences} />
      </div>
    </AdminContent>
  );
}
