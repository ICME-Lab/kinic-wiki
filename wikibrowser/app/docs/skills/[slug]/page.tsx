// Where: /docs/skills/[slug].
// What: renders one documented agent workflow skill.
// Why: skill docs need stable, deep-linkable pages without touching the Skill Registry UI.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldCheck, TerminalSquare, Workflow } from "lucide-react";
import { CliGuideBlock } from "@/app/docs/cli/cli-guide-block";
import { AdminContent } from "@/components/admin-shell";
import { AdminPanel } from "@/components/admin-ui";
import { findSkillDoc, skillDocs } from "../../docs-data";

type SkillDocPageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return skillDocs.map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: SkillDocPageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = findSkillDoc(slug);
  if (!doc) {
    return {
      title: "Kinic Wiki Skill Docs"
    };
  }
  return {
    title: `Kinic Wiki ${doc.title} Skill`,
    description: doc.description,
    openGraph: {
      title: `Kinic Wiki ${doc.title} Skill`,
      description: doc.description
    },
    twitter: {
      title: `Kinic Wiki ${doc.title} Skill`,
      description: doc.description
    }
  };
}

export default async function SkillDocPage({ params }: SkillDocPageProps) {
  const { slug } = await params;
  const doc = findSkillDoc(slug);
  if (!doc) notFound();

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

        <div className="grid gap-4 lg:grid-cols-[1fr_0.95fr]">
          <CliGuideBlock icon={<TerminalSquare aria-hidden size={18} />} title="Common commands" commands={doc.commandLines}>
            Use these as entry examples. Add <code>--canister-id</code>, <code>--identity-mode</code>, or workspace database config when the target environment requires it.
          </CliGuideBlock>
          <AdminPanel className="min-w-0" padding="lg">
            <div className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="text-accent" size={18} />
              <h2 className="text-lg font-semibold text-ink">Safety</h2>
            </div>
            <ul className="mt-4 grid gap-2 text-sm leading-6 text-muted">
              {doc.safety.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </AdminPanel>
        </div>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <Workflow aria-hidden className="text-accent" size={18} />
            <h2 className="text-lg font-semibold text-ink">Responsibilities</h2>
          </div>
          <ul className="mt-4 grid gap-2 text-sm leading-6 text-muted md:grid-cols-2">
            {doc.responsibilities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </AdminPanel>
      </div>
    </AdminContent>
  );
}
