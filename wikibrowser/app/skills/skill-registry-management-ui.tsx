"use client";

import type { ReactNode } from "react";
import { ChevronDown, Github, ShieldCheck, Upload } from "lucide-react";
import type { DatabaseRole } from "@/lib/types";
import type { SkillCatalog } from "@/lib/skill-registry-package";

export type PackageDraft = {
  source: string;
  reference: string;
  id: string;
  catalog: SkillCatalog;
  skill: string;
  manifest: string;
  provenance: string;
  evals: string;
  extraName: string;
  extraContent: string;
};

export type PackageHandlers = {
  setDraft: (patch: Partial<PackageDraft>) => void;
  importGitHub: () => void;
  pasteUpsert: () => void;
};

export function RoleBanner({ role, principal }: { role: DatabaseRole | null; principal: string | null }) {
  const writable = role === "writer" || role === "owner";
  return (
    <section className="rounded-lg border border-line bg-paper p-4 text-sm">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 rounded-md border p-1.5 ${writable ? "border-green-200 bg-green-50 text-green-700" : "border-line bg-white text-muted"}`}>
          <ShieldCheck aria-hidden size={17} />
        </span>
        <div className="min-w-0">
          <p className="font-medium text-ink">Database Role: {role ?? (principal ? "unknown" : "anonymous")}</p>
          <p className="mt-1 text-muted">{writable ? "Write operations enabled." : "Writer or owner access required."}</p>
        </div>
      </div>
    </section>
  );
}

export function PackageManager({
  draft,
  busy,
  writable,
  message,
  handlers
}: {
  draft: PackageDraft;
  busy: boolean;
  writable: boolean;
  message: string | null;
  handlers: PackageHandlers;
}) {
  return (
    <details className="group rounded-lg border border-line bg-paper">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <span className="min-w-0">Add Or Update Package</span>
        <ChevronDown aria-hidden className="shrink-0 transition-transform group-open:rotate-180" size={17} />
      </summary>
      <div className="grid gap-5 border-t border-line p-4">
        <section>
          <PanelHeading icon={<Github aria-hidden size={16} />} title="GitHub Import" />
          <div className="mt-3 grid gap-3">
            <Field label="Repository Path" name="github-source">
              <input
                autoComplete="off"
                className={inputClass}
                name="github-source"
                placeholder="owner/repo:path…"
                spellCheck={false}
                type="text"
                value={draft.source}
                onChange={(event) => handlers.setDraft({ source: event.target.value })}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              <Field label="Ref" name="github-reference">
                <input
                  autoComplete="off"
                  className={inputClass}
                  name="github-reference"
                  placeholder="main…"
                  spellCheck={false}
                  type="text"
                  value={draft.reference}
                  onChange={(event) => handlers.setDraft({ reference: event.target.value })}
                />
              </Field>
              <Field label="Skill ID" name="github-skill-id">
                <input
                  autoComplete="off"
                  className={inputClass}
                  name="github-skill-id"
                  placeholder="skill-id…"
                  spellCheck={false}
                  type="text"
                  value={draft.id}
                  onChange={(event) => handlers.setDraft({ id: event.target.value })}
                />
              </Field>
              <Field label="Catalog" name="github-catalog">
                <CatalogSelect id="github-catalog" value={draft.catalog} onChange={(catalog) => handlers.setDraft({ catalog })} />
              </Field>
            </div>
            <p className="text-xs leading-5 text-muted">Public GitHub repositories only. Browser API cannot prune deleted files.</p>
            <button className={primaryButtonClass} disabled={!writable || busy || !draft.source.trim() || !draft.id.trim()} type="button" onClick={handlers.importGitHub}>
              Import From GitHub
            </button>
          </div>
        </section>
        <section className="border-t border-line pt-5">
          <PanelHeading icon={<Upload aria-hidden size={16} />} title="Paste Upsert" />
          <div className="mt-3 grid gap-3">
            <Field label="SKILL.md" name="paste-skill">
              <textarea
                autoComplete="off"
                className={`${inputClass} min-h-28 resize-y`}
                name="paste-skill"
                placeholder="Paste SKILL.md…"
                spellCheck={false}
                value={draft.skill}
                onChange={(event) => handlers.setDraft({ skill: event.target.value })}
              />
            </Field>
            <Field label="manifest.md" name="paste-manifest" optional>
              <textarea
                autoComplete="off"
                className={`${inputClass} min-h-20 resize-y`}
                name="paste-manifest"
                placeholder="Paste manifest.md…"
                spellCheck={false}
                value={draft.manifest}
                onChange={(event) => handlers.setDraft({ manifest: event.target.value })}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              <Field label="Extra File" name="paste-extra-name">
                <input
                  autoComplete="off"
                  className={inputClass}
                  name="paste-extra-name"
                  placeholder="extra.md…"
                  spellCheck={false}
                  type="text"
                  value={draft.extraName}
                  onChange={(event) => handlers.setDraft({ extraName: event.target.value })}
                />
              </Field>
              <Field label="Skill ID" name="paste-skill-id">
                <input
                  autoComplete="off"
                  className={inputClass}
                  name="paste-skill-id"
                  placeholder="skill-id…"
                  spellCheck={false}
                  type="text"
                  value={draft.id}
                  onChange={(event) => handlers.setDraft({ id: event.target.value })}
                />
              </Field>
              <Field label="Catalog" name="paste-catalog">
                <CatalogSelect id="paste-catalog" value={draft.catalog} onChange={(catalog) => handlers.setDraft({ catalog })} />
              </Field>
            </div>
            <Field label="Extra Markdown" name="paste-extra-content">
              <textarea
                autoComplete="off"
                className={`${inputClass} min-h-20 resize-y`}
                name="paste-extra-content"
                placeholder="Paste extra markdown…"
                spellCheck={false}
                value={draft.extraContent}
                onChange={(event) => handlers.setDraft({ extraContent: event.target.value })}
              />
            </Field>
            <button className={primaryButtonClass} disabled={!writable || busy || !draft.skill.trim() || !draft.id.trim()} type="button" onClick={handlers.pasteUpsert}>
              Upsert Pasted Package
            </button>
          </div>
        </section>
        {message ? <p aria-live="polite" className="rounded-lg border border-line bg-white px-3 py-2 text-xs text-muted">{message}</p> : null}
      </div>
    </details>
  );
}

const inputClass = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const primaryButtonClass = "rounded-2xl border border-action bg-action px-3 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function PanelHeading({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-medium text-ink">
      {icon}
      <h2 className="text-sm font-medium">{title}</h2>
    </div>
  );
}

function Field({ label, name, optional = false, children }: { label: string; name: string; optional?: boolean; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm" htmlFor={name}>
      <span className="flex items-center justify-between gap-2 text-xs font-medium uppercase text-muted">
        <span>{label}</span>
        {optional ? <span className="normal-case">optional</span> : null}
      </span>
      {children}
    </label>
  );
}

function CatalogSelect({ id, value, onChange }: { id: string; value: SkillCatalog; onChange: (value: SkillCatalog) => void }) {
  return (
    <select id={id} className={inputClass} name={id} value={value} onChange={(event) => onChange(event.target.value === "public" ? "public" : "private")}>
      <option value="private">private</option>
      <option value="public">public</option>
    </select>
  );
}
