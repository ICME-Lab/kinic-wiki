"use client";

import type { ReactNode } from "react";
import { RefreshCw, Search } from "lucide-react";
import { MemberTable } from "@/app/dashboard/member-table";
import { RunSummary } from "@/app/skills/skill-registry-ui";
import type { CatalogSkill, StatusFilter } from "@/lib/skill-registry-catalog";
import type { DatabaseMember } from "@/lib/types";

export type DashboardTab = "overview" | "detail" | "runs" | "permissions";

export function SkillRegistryHeader({
  databaseId,
  principal,
  loading,
  authReady,
  onRefresh,
  onLogin,
  onLogout
}: {
  databaseId: string;
  principal: string | null;
  loading: boolean;
  authReady: boolean;
  onRefresh: () => void;
  onLogin: () => void;
  onLogout: () => void;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-line pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-sm text-muted">Kinic Skill Registry</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink sm:text-3xl">Skill Registry Dashboard</h1>
        <p className="mt-1 max-w-full truncate font-mono text-xs text-muted">{databaseId || "unknown database"}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {principal ? <span className="max-w-[320px] truncate rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs text-muted">{principal}</span> : null}
        <button className="inline-flex items-center rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink hover:border-accent disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" disabled={loading} type="button" onClick={onRefresh}>
          <RefreshCw aria-hidden size={15} />
          <span className="ml-2">Refresh</span>
        </button>
        {principal ? (
          <button className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" type="button" onClick={onLogout}>
            Logout
          </button>
        ) : (
          <button className="rounded-2xl border border-action bg-action px-3 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:translate-y-0 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" disabled={!authReady} type="button" onClick={onLogin}>
            Login
          </button>
        )}
      </div>
    </header>
  );
}

export function SkillRegistryTabs({ activeTab, onChange }: { activeTab: DashboardTab; onChange: (tab: DashboardTab) => void }) {
  return (
    <nav className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-paper p-2 text-sm sm:grid-cols-4">
      {(["overview", "detail", "runs", "permissions"] as const).map((tab) => (
        <button key={tab} className={`rounded-md px-2 py-2 capitalize ${activeTab === tab ? "bg-accent text-white" : "bg-white text-ink"}`} type="button" onClick={() => onChange(tab)}>
          {tab.replace("-", " ")}
        </button>
      ))}
    </nav>
  );
}

export function SkillRegistrySearchFilter({ query, statusFilter, onQueryChange, onStatusFilterChange }: { query: string; statusFilter: StatusFilter; onQueryChange: (value: string) => void; onStatusFilterChange: (value: StatusFilter) => void }) {
  return (
    <section className="grid gap-3 rounded-lg border border-line bg-paper p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <label className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
        <Search aria-hidden className="shrink-0 text-muted" size={17} />
        <span className="sr-only">Search Skills</span>
        <input
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
          name="skill-registry-search"
          placeholder="Search skills, tags, use cases, provenance..."
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>
      <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-line bg-white text-sm">
        {(["active", "all", "deprecated"] as const).map((value) => (
          <button key={value} className={`px-3 py-2 capitalize hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${statusFilter === value ? "bg-accent text-white hover:bg-accentHover" : "text-ink"}`} type="button" onClick={() => onStatusFilterChange(value)}>
            {value}
          </button>
        ))}
      </div>
    </section>
  );
}

export function PermissionsPanel({ databaseId, members, principal, writable }: { databaseId: string; members: DatabaseMember[]; principal: string | null; writable: boolean }) {
  return (
    <section className="rounded-lg border border-line bg-paper">
      <div className="border-b border-line p-4">
        <h2 className="text-base font-semibold text-ink">Permissions</h2>
        {!writable ? <p className="mt-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-2 text-xs text-yellow-900">Writer access required: kinic-vfs-cli database grant-current-identity {databaseId} writer</p> : null}
      </div>
      <MemberTable busy={false} busyAction={null} members={members} principal={principal ?? "anonymous"} readOnly onRevoke={() => undefined} onRoleChange={() => undefined} />
    </section>
  );
}

export function SkillDetailPanel({
  skills,
  skill,
  onSelect,
  focus = "detail",
}: {
  skills: CatalogSkill[];
  skill: CatalogSkill;
  onSelect: (id: string) => void;
  focus?: "detail" | "runs";
}) {
  return (
    <section className="rounded-lg border border-line bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">{skill.manifest.title ?? skill.manifest.id}</h2>
        <select className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink" value={skill.manifest.id} onChange={(event) => onSelect(event.target.value)}>
          {skills.map((item) => <option key={item.manifest.id} value={item.manifest.id}>{item.manifest.id}</option>)}
        </select>
      </div>
      {focus === "detail" ? (
        <div className="mt-4 grid gap-3">
          <Panel title="Current SKILL.md">
            <pre className="max-h-96 overflow-auto rounded border border-line bg-white p-3 text-xs text-ink">{skill.currentSkill || "SKILL.md not loaded."}</pre>
          </Panel>
          <Panel title="Versions">
            {skill.versions.length > 0 ? skill.versions.map((version) => <p key={version.path} className="truncate font-mono text-xs text-muted">{version.path}</p>) : <p className="text-sm text-muted">No versions.</p>}
          </Panel>
          <Panel title="Corrections">
            {skill.corrections.length > 0 ? skill.corrections.map((correction) => <p key={correction.path} className="truncate font-mono text-xs text-muted">{correction.path}</p>) : <p className="text-sm text-muted">No corrections.</p>}
          </Panel>
        </div>
      ) : null}
      {focus === "runs" ? <RunSummary skill={skill} /> : null}
    </section>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white p-3">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}
