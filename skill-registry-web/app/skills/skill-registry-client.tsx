"use client";

import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PackageManager, RoleBanner } from "@/app/skills/skill-registry-management-ui";
import { EvolutionJobsPanel, PermissionsPanel, SkillDetailPanel, SkillRegistryHeader, SkillRegistrySearchFilter, SkillRegistryTabs, type DashboardTab } from "@/app/skills/skill-registry-panels";
import { usePackageManager } from "@/app/skills/skill-registry-package-state";
import { EmptyState, SkillCard, StatusPanel, SummaryStrip, type SkillActionHandlers } from "@/app/skills/skill-registry-ui";
import { AUTH_CLIENT_CREATE_OPTIONS, authLoginOptions } from "@/lib/auth";
import { filterSkills, loadSkillCatalog, summarizeSkills, type CatalogSkill, type EvolutionJob, type StatusFilter } from "@/lib/skill-registry-catalog";
import { loadEvolutionJobs, loadSkillCatalogDetails } from "@/lib/skill-registry-details";
import { applyProposalDiff, previewApplyProposalDiff, type ProposalDiffPreview } from "@/lib/skill-registry-diff";
import { approveSkillProposal, recordSkillEvent, recordSkillRun, updateSkillStatus, type RunOutcome, type SkillStatus } from "@/lib/skill-registry-operations";
import type { DatabaseMember, DatabaseRole } from "@/lib/types";
import { listDatabaseMembersAuthenticated, listDatabaseMembersPublic, listDatabasesAuthenticated } from "@/lib/vfs-client";
type LoadState = "idle" | "loading" | "ready" | "error";
type ActionDraft = {
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

const DEFAULT_ACTION: ActionDraft = {
  busy: false,
  error: null,
  message: null,
  preview: null,
  statusReason: "",
  runTask: "",
  runOutcome: "success",
  runAgent: "browser",
  runNotes: ""
};
export function SkillRegistryClient({ databaseId }: { databaseId: string }) {
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const refreshSeqRef = useRef(0);
  const [authClient, setAuthClient] = useState<AuthClient | null>(null);
  const [principal, setPrincipal] = useState<string | null>(null);
  const [skills, setSkills] = useState<CatalogSkill[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [actions, setActions] = useState<Record<string, ActionDraft>>({});
  const [databaseRole, setDatabaseRole] = useState<DatabaseRole | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<EvolutionJob[]>([]);
  const [members, setMembers] = useState<DatabaseMember[]>([]);

  const loadCatalog = useCallback(
    async (identity?: Identity) => {
      const refreshSeq = (refreshSeqRef.current += 1);
      const isCurrentRefresh = () => refreshSeq === refreshSeqRef.current;
      if (!canisterId) {
        setError("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured.");
        setLoadState("error");
        return;
      }
      if (!databaseId) {
        setError("Database id is missing.");
        setLoadState("error");
        return;
      }
      setLoadState("loading");
      setError(null);
      try {
        const nextSkills = await loadSkillCatalog(canisterId, databaseId, identity);
        if (!isCurrentRefresh()) return;
        setSkills(nextSkills);
        setLoadState("ready");
        void loadSkillCatalogDetails(canisterId, databaseId, nextSkills, identity)
          .then((detailedSkills) => {
            if (!isCurrentRefresh()) return;
            setSkills(detailedSkills);
            setSelectedSkillId((current) => current ?? detailedSkills[0]?.manifest.id ?? null);
          })
          .catch(() => undefined);
        void loadEvolutionJobs(canisterId, databaseId, identity)
          .then((nextJobs) => {
            if (!isCurrentRefresh()) return;
            setJobs(nextJobs);
          })
          .catch(() => undefined);
      } catch (cause) {
        if (!isCurrentRefresh()) return;
        setError(errorMessage(cause));
        setLoadState("error");
      }
    },
    [canisterId, databaseId]
  );

  const loadRole = useCallback(async (activeIdentity: Identity) => {
    try {
      const databases = await listDatabasesAuthenticated(canisterId, activeIdentity);
      setDatabaseRole(databases.find((database) => database.databaseId === databaseId)?.role ?? null);
      setMembers(await listDatabaseMembersAuthenticated(canisterId, activeIdentity, databaseId));
    } catch {
      setDatabaseRole(null);
      setMembers([]);
    }
  }, [canisterId, databaseId]);

  useEffect(() => {
    let cancelled = false;
    AuthClient.create(AUTH_CLIENT_CREATE_OPTIONS)
      .then(async (client) => {
        if (cancelled) return;
        setAuthClient(client);
        if (await client.isAuthenticated()) {
          const identity = client.getIdentity();
          setPrincipal(identity.getPrincipal().toText());
          await loadRole(identity);
          await loadCatalog(identity);
        } else {
          listDatabaseMembersPublic(canisterId, databaseId).then(setMembers).catch(() => setMembers([]));
          await loadCatalog();
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(errorMessage(cause));
        setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, databaseId, loadCatalog, loadRole]);

  async function login() {
    if (!authClient) return;
    setError(null);
    await authClient.login({
      ...authLoginOptions(),
      onSuccess: () => {
        const identity = authClient.getIdentity();
        setPrincipal(identity.getPrincipal().toText());
        void loadRole(identity);
        void loadCatalog(identity);
      },
      onError: (cause) => {
        setError(errorMessage(cause));
        setLoadState("error");
      }
    });
  }

  async function logout() {
    if (!authClient) return;
    refreshSeqRef.current += 1;
    await authClient.logout();
    setPrincipal(null);
    setDatabaseRole(null);
    setSkills([]);
    setError(null);
    setLoadState("idle");
    await loadCatalog();
  }

  const filteredSkills = useMemo(() => filterSkills(skills, query, statusFilter), [skills, query, statusFilter]);
  const summary = useMemo(() => summarizeSkills(skills), [skills]);
  const selectedSkill = useMemo(() => skills.find((skill) => skill.manifest.id === selectedSkillId) ?? skills[0] ?? null, [selectedSkillId, skills]);
  const pendingJobs = jobs.filter((job) => job.status === "queued" || job.status === "running").length;
  const conflictJobs = jobs.filter((job) => job.status === "conflict").length;
  const identity = authClient?.getIdentity();
  const writable = databaseRole === "writer" || databaseRole === "owner";
  const packageManager = usePackageManager({ canisterId, databaseId, identity, writable, refresh: loadCatalog, errorMessage });
  function actionFor(skill: CatalogSkill): ActionDraft {
    return actions[skill.manifest.id] ?? DEFAULT_ACTION;
  }

  function patchAction(skill: CatalogSkill, patch: Partial<ActionDraft>) {
    setActions((current) => ({ ...current, [skill.manifest.id]: { ...DEFAULT_ACTION, ...current[skill.manifest.id], ...patch } }));
  }

  async function runSkillAction(skill: CatalogSkill, operation: (identity: Identity, draft: ActionDraft) => Promise<void>, clearRun = false) {
    if (!identity) {
      patchAction(skill, { error: "Login is required." });
      return;
    }
    const draft = actionFor(skill);
    patchAction(skill, { busy: true, error: null });
    try {
      await operation(identity, draft);
      patchAction(skill, clearRun ? { busy: false, runTask: "", runNotes: "", message: "Operation completed." } : { busy: false, message: "Operation completed." });
      await loadCatalog(identity);
    } catch (cause) {
      patchAction(skill, { busy: false, error: errorMessage(cause) });
    }
  }

  function handlersFor(skill: CatalogSkill): SkillActionHandlers {
    return {
      setStatusReason: (value) => patchAction(skill, { statusReason: value }),
      setRunTask: (value) => patchAction(skill, { runTask: value }),
      setRunOutcome: (value) => patchAction(skill, { runOutcome: value }),
      setRunAgent: (value) => patchAction(skill, { runAgent: value }),
      setRunNotes: (value) => patchAction(skill, { runNotes: value }),
      updateStatus: (status: SkillStatus) => void runSkillAction(skill, (activeIdentity, draft) => updateSkillStatus(canisterId, databaseId, activeIdentity, skill, status, draft.statusReason)),
      recordRun: () =>
        void runSkillAction(
          skill,
          (activeIdentity, draft) =>
            recordSkillRun(canisterId, databaseId, activeIdentity, skill, {
              task: draft.runTask,
              outcome: draft.runOutcome,
              agent: draft.runAgent,
              notes: draft.runNotes
            }),
          true
        ),
      approveProposal: (proposal) => void runSkillAction(skill, (activeIdentity) => approveSkillProposal(canisterId, databaseId, activeIdentity, skill, proposal.proposalRoot)),
      previewProposal: (proposal) =>
        void runSkillAction(skill, async (activeIdentity) => {
          const preview = await previewApplyProposalDiff(canisterId, databaseId, activeIdentity, skill, proposal);
          patchAction(skill, { preview, message: `Preview ready: ${preview.targetPath}` });
        }),
      applyProposal: (proposal) =>
        void runSkillAction(skill, async (activeIdentity, draft) => {
          if (!draft.preview || draft.preview.proposalPath !== proposal.proposalRoot) throw new Error("Preview this proposal before applying.");
          await applyProposalDiff(canisterId, databaseId, activeIdentity, proposal, draft.preview);
          await recordSkillEvent(canisterId, databaseId, activeIdentity, skill.manifest.id, { action: "proposal.apply", targetPath: draft.preview.targetPath, result: "applied" });
        })
    };
  }

  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <section className="mx-auto flex max-w-7xl flex-col gap-5">
        <SkillRegistryHeader
          authReady={Boolean(authClient)}
          databaseId={databaseId}
          loading={loadState === "loading"}
          principal={principal}
          onLogin={() => void login()}
          onLogout={() => void logout()}
          onRefresh={() => void loadCatalog(authClient?.getIdentity())}
        />

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <div className="min-w-0 space-y-5">
            <SummaryStrip summary={summary} />
            <SkillRegistryTabs activeTab={activeTab} onChange={setActiveTab} />
            <SkillRegistrySearchFilter query={query} statusFilter={statusFilter} onQueryChange={setQuery} onStatusFilterChange={setStatusFilter} />

            {error ? <StatusPanel tone="error" message={error} /> : null}
            {loadState === "loading" ? <StatusPanel tone="info" message="Loading skill registry…" /> : null}
            {activeTab === "overview" && loadState === "ready" && skills.length === 0 ? <EmptyState /> : null}

            {activeTab === "overview" && filteredSkills.length > 0 ? (
              <section className="grid gap-3 lg:grid-cols-2">
                {filteredSkills.map((skill) => (
                  <SkillCard
                    key={skill.manifestPath}
                    canisterId={canisterId}
                    databaseId={databaseId}
                    skill={skill}
                    authenticated={Boolean(principal)}
                    writable={writable}
                    action={actionFor(skill)}
                    handlers={handlersFor(skill)}
                  />
                ))}
              </section>
            ) : activeTab === "overview" && loadState === "ready" && skills.length > 0 ? (
              <StatusPanel tone="info" message="No skills match the current filter." />
            ) : null}
            {activeTab === "detail" && selectedSkill ? <SkillDetailPanel skill={selectedSkill} onSelect={setSelectedSkillId} skills={skills} /> : null}
            {activeTab === "runs" && selectedSkill ? <SkillDetailPanel focus="runs" skill={selectedSkill} onSelect={setSelectedSkillId} skills={skills} /> : null}
            {activeTab === "proposals" && selectedSkill ? <SkillDetailPanel focus="proposals" skill={selectedSkill} onSelect={setSelectedSkillId} skills={skills} authenticated={Boolean(principal)} writable={writable} busy={actionFor(selectedSkill).busy} preview={actionFor(selectedSkill).preview} handlers={handlersFor(selectedSkill)} /> : null}
            {activeTab === "jobs" ? <EvolutionJobsPanel jobs={jobs} pendingJobs={pendingJobs} conflictJobs={conflictJobs} /> : null}
            {activeTab === "permissions" ? <PermissionsPanel databaseId={databaseId} members={members} principal={principal} writable={writable} /> : null}
          </div>
          <aside className="space-y-3 lg:sticky lg:top-6">
            <RoleBanner role={databaseRole} principal={principal} />
            <PackageManager draft={packageManager.draft} busy={packageManager.busy} writable={writable} message={packageManager.message} handlers={packageManager.handlers} />
          </aside>
        </div>
      </section>
    </main>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected error";
}
