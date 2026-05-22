"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { BookOpen, CheckCircle2, ExternalLink, PlayCircle, ShieldCheck, XCircle } from "lucide-react";
import { hrefForPath } from "@/lib/paths";
import type { CatalogSkill, CatalogSummary, SkillProposal } from "@/lib/skill-registry-catalog";
import type { RunOutcome, SkillStatus } from "@/lib/skill-registry-operations";
import type { ProposalDiffPreview } from "@/lib/skill-registry-diff";

export type SkillActionState = {
  busy: boolean;
  error: string | null;
  message: string | null;
  preview: ProposalDiffPreview | null;
  statusReason: string;
  runTask: string;
  runOutcome: RunOutcome;
  runAgent: string;
  runNotes: string;
};

export type SkillActionHandlers = {
  setStatusReason: (value: string) => void;
  setRunTask: (value: string) => void;
  setRunOutcome: (value: RunOutcome) => void;
  setRunAgent: (value: string) => void;
  setRunNotes: (value: string) => void;
  updateStatus: (status: SkillStatus) => void;
  recordRun: () => void;
  approveProposal: (proposal: SkillProposal) => void;
  previewProposal: (proposal: SkillProposal) => void;
  applyProposal: (proposal: SkillProposal) => void;
};

export function SummaryStrip({ summary }: { summary: CatalogSummary }) {
  return (
    <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      <SummaryMetric label="Total" value={summary.total} icon={<BookOpen size={17} />} />
      <SummaryMetric label="Promoted" value={summary.promoted} icon={<ShieldCheck size={17} />} />
      <SummaryMetric label="Reviewed" value={summary.reviewed} icon={<CheckCircle2 size={17} />} />
      <SummaryMetric label="Draft" value={summary.draft} icon={<BookOpen size={17} />} />
      <SummaryMetric label="Deprecated" value={summary.deprecated} icon={<XCircle size={17} />} />
    </section>
  );
}

export function SkillCard({
  canisterId,
  databaseId,
  skill,
  authenticated,
  writable,
  action,
  handlers
}: {
  canisterId: string;
  databaseId: string;
  skill: CatalogSkill;
  authenticated: boolean;
  writable: boolean;
  action: SkillActionState;
  handlers: SkillActionHandlers;
}) {
  const manifest = skill.manifest;
  const status = manifest.status ?? "draft";
  return (
    <article className="rounded-lg border border-line bg-paper p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-line bg-white px-2 py-1 text-xs font-medium text-muted">{skill.rootLabel}</span>
            <span className={`rounded px-2 py-1 text-xs font-medium ${statusClass(status)}`}>{status}</span>
          </div>
          <h2 className="mt-3 text-lg font-semibold text-ink">{manifest.title ?? manifest.id}</h2>
          <p className="mt-1 font-mono text-xs text-muted">{manifest.id}</p>
        </div>
        <Link className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink no-underline hover:border-accent" href={hrefForPath(canisterId, databaseId, skill.basePath)}>
          Open
          <ExternalLink aria-hidden size={14} />
        </Link>
      </div>
      {manifest.summary ? <p className="mt-3 text-sm leading-6 text-muted">{manifest.summary}</p> : null}
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Meta label="version" value={manifest.version} />
        <Meta label="entry" value={manifest.entry} />
        <Meta label="source" value={manifest.provenance.source ?? manifest.provenance.source_url ?? "-"} />
        <Meta label="revision" value={manifest.provenance.revision ?? manifest.provenance.source_ref ?? "-"} />
      </dl>
      {manifest.tags.length > 0 ? <TokenRow label="Tags" values={manifest.tags} /> : null}
      {manifest.useCases.length > 0 ? <TokenRow label="Use cases" values={manifest.useCases} /> : null}
      {manifest.knowledge.length > 0 ? <TokenRow label="Knowledge" values={manifest.knowledge} mono /> : null}
      {skill.missingFiles.length > 0 ? <p className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">Missing package files: {skill.missingFiles.join(", ")}</p> : null}
      <OperationsPanel skill={skill} authenticated={authenticated} writable={writable} action={action} handlers={handlers} />
    </article>
  );
}

function OperationsPanel({ skill, authenticated, writable, action, handlers }: { skill: CatalogSkill; authenticated: boolean; writable: boolean; action: SkillActionState; handlers: SkillActionHandlers }) {
  return (
    <section className="mt-5 grid gap-4 border-t border-line pt-4">
      <TrustSummary skill={skill} />
      <div>
        <p className="text-xs uppercase tracking-[0.12em] text-muted">Status</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(["draft", "reviewed", "promoted", "deprecated"] as const).map((status) => (
            <button key={status} className="rounded-lg border border-line bg-white px-3 py-2 text-xs text-ink disabled:opacity-50" disabled={!authenticated || !writable || action.busy} type="button" onClick={() => handlers.updateStatus(status)}>
              {status}
            </button>
          ))}
        </div>
        <input className="mt-2 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none" placeholder="Deprecated reason" value={action.statusReason} onChange={(event) => handlers.setStatusReason(event.target.value)} />
      </div>
      <div>
        <p className="text-xs uppercase tracking-[0.12em] text-muted">Run Evidence</p>
        <div className="mt-2 grid gap-2">
          <input className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none" placeholder="Task" value={action.runTask} onChange={(event) => handlers.setRunTask(event.target.value)} />
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <select className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" value={action.runOutcome} onChange={(event) => handlers.setRunOutcome(event.target.value as RunOutcome)}>
              <option value="success">success</option>
              <option value="partial">partial</option>
              <option value="fail">fail</option>
            </select>
            <input className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none" placeholder="Agent" value={action.runAgent} onChange={(event) => handlers.setRunAgent(event.target.value)} />
            <button className="inline-flex items-center justify-center gap-2 rounded-2xl border border-action bg-action px-3 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:translate-y-0 disabled:opacity-50" disabled={!authenticated || !writable || action.busy || !action.runTask.trim()} type="button" onClick={handlers.recordRun}>
              <PlayCircle aria-hidden size={15} />
              Record
            </button>
          </div>
          <textarea className="min-h-20 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none" placeholder="Notes" value={action.runNotes} onChange={(event) => handlers.setRunNotes(event.target.value)} />
        </div>
        <RunSummary skill={skill} />
      </div>
      <ProposalList skill={skill} authenticated={authenticated} writable={writable} busy={action.busy} preview={action.preview ?? null} onApprove={handlers.approveProposal} onPreview={handlers.previewProposal} onApply={handlers.applyProposal} />
      <EventList skill={skill} />
      {action.message ? <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">{action.message}</p> : null}
      {action.error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">{action.error}</p> : null}
    </section>
  );
}

function TrustSummary({ skill }: { skill: CatalogSkill }) {
  const trust = skill.trust;
  return (
    <div className="rounded-lg border border-line bg-white p-3 text-xs text-muted">
      <p className="font-medium text-ink">Trust: {trust.runs} runs · {trust.success} success · {trust.partial} partial · {trust.fail} fail</p>
      <p className="mt-1">Last: {trust.lastOutcome ?? "-"} {trust.lastUsedAt ? `at ${trust.lastUsedAt}` : ""}</p>
    </div>
  );
}

export function RunSummary({ skill }: { skill: CatalogSkill }) {
  return (
    <div className="mt-3 rounded-lg border border-line bg-white p-3 text-xs text-muted">
      <p>success {skill.runSummary.success} / partial {skill.runSummary.partial} / fail {skill.runSummary.fail}</p>
      {skill.recentRuns.length > 0 ? skill.recentRuns.map((run) => <p key={run.path} className="mt-1 truncate">task {run.taskOutcome} / agent {run.agentOutcome} · {run.task || run.path}</p>) : <p className="mt-1">No recorded runs.</p>}
    </div>
  );
}

export function ProposalList({
  skill,
  authenticated,
  writable,
  busy,
  preview,
  onApprove,
  onPreview,
  onApply
}: {
  skill: CatalogSkill;
  authenticated: boolean;
  writable: boolean;
  busy: boolean;
  preview: ProposalDiffPreview | null;
  onApprove: (proposal: SkillProposal) => void;
  onPreview: (proposal: SkillProposal) => void;
  onApply: (proposal: SkillProposal) => void;
}) {
  if (skill.proposals.length === 0) return <p className="rounded-lg border border-line bg-white px-3 py-2 text-xs text-muted">No evolution proposals.</p>;
  return (
    <div className="rounded-lg border border-line bg-white p-3">
      <p className="text-xs uppercase tracking-[0.12em] text-muted">Evolution Proposals</p>
      {skill.proposals.slice(0, 4).map((proposal) => (
        <div key={proposal.proposalRoot} className="mt-3 grid gap-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-ink">{proposal.title}</span>
            <span className="rounded border border-line px-2 py-1 text-muted">{proposal.status}</span>
          </div>
          {proposal.sourceRuns.length > 0 ? <p className="truncate text-muted">runs: {proposal.sourceRuns.join(", ")}</p> : null}
          {proposal.baseEtag ? <p className="truncate font-mono text-muted">base_etag: {proposal.baseEtag}</p> : null}
          <pre className="max-h-28 overflow-auto rounded border border-line bg-paper p-2 text-[11px] text-muted">{proposal.candidatePreview}</pre>
          <pre className="max-h-28 overflow-auto rounded border border-line bg-paper p-2 text-[11px] text-muted">{proposal.metricsPreview}</pre>
          <div className="flex flex-wrap gap-2">
            <button className="rounded border border-line px-2 py-1 text-muted disabled:opacity-50" disabled={!authenticated || !writable || busy || proposal.status !== "proposed"} type="button" onClick={() => onApprove(proposal)}>Mark reviewed</button>
            <button className="rounded border border-line px-2 py-1 text-muted disabled:opacity-50" disabled={!authenticated || !writable || busy || proposal.status !== "proposed"} type="button" onClick={() => onPreview(proposal)}>Preview apply</button>
            <button className="rounded border border-line px-2 py-1 text-muted disabled:opacity-50" disabled={!authenticated || !writable || busy || preview?.proposalPath !== proposal.proposalRoot} type="button" onClick={() => onApply(proposal)}>Apply</button>
          </div>
          {preview?.proposalPath === proposal.proposalRoot ? <p className="text-muted">Preview: {preview.targetPath} +{preview.additions} -{preview.removals}</p> : null}
        </div>
      ))}
    </div>
  );
}

function EventList({ skill }: { skill: CatalogSkill }) {
  if (skill.events.length === 0) return <p className="rounded-lg border border-line bg-white px-3 py-2 text-xs text-muted">No skill events.</p>;
  return (
    <div className="rounded-lg border border-line bg-white p-3 text-xs text-muted">
      <p className="uppercase tracking-[0.12em]">Events</p>
      {skill.events.map((event) => <p key={event.path} className="mt-1 truncate">{event.action} · {event.result} · {event.recordedAt}</p>)}
    </div>
  );
}

function SummaryMetric({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-paper px-3 py-3">
      <div className="flex items-center justify-between text-muted">
        <span className="text-xs font-medium uppercase text-muted">{label}</span>
        {icon}
      </div>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className="mt-1 truncate text-ink">{value}</dd>
    </div>
  );
}

function TokenRow({ label, values, mono = false }: { label: string; values: string[]; mono?: boolean }) {
  return (
    <div className="mt-4">
      <p className="text-xs uppercase tracking-[0.12em] text-muted">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.slice(0, 8).map((value) => (
          <span key={value} className={`rounded border border-line bg-white px-2 py-1 text-xs text-muted ${mono ? "font-mono" : ""}`}>{value}</span>
        ))}
      </div>
    </div>
  );
}

export function EmptyState() {
  return (
    <section className="rounded-lg border border-line bg-paper p-6 text-sm text-muted">
      <h2 className="text-base font-semibold text-ink">No Skill Packages</h2>
      <p className="mt-2">No packages found under /Wiki/skills.</p>
      <p className="mt-2">
        Open <span className="font-medium text-ink">Add Or Update Package</span> to import from GitHub or paste a package.
      </p>
    </section>
  );
}

export function StatusPanel({ tone, message }: { tone: "error" | "info"; message: string }) {
  const toneClass = tone === "error" ? "border-red-200 bg-red-50 text-red-900" : "border-line bg-paper text-ink";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${toneClass}`}>{message}</div>;
}

function statusClass(status: string): string {
  if (status === "promoted") return "bg-green-100 text-green-800";
  if (status === "reviewed") return "bg-accentSoft text-accentText";
  if (status === "deprecated") return "bg-red-100 text-red-800";
  return "bg-yellow-100 text-yellow-800";
}
