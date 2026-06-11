"use client";

import type { AuthClient } from "@icp-sdk/auth/client";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BusyAction } from "./access-control";
import { BuyersPanel, CyclesHistoryPanel, DashboardSettingsPanel, DashboardTabs, MarketListingsPanel, OwnerPanel, PendingDatabasePanel, ReadonlyMembersPanel, RenameDatabaseDialog, StatusPanel, SummaryPanel, type DashboardTab } from "./dashboard-ui";
import { useAppSession } from "../app-session-provider";
import { AdminContent } from "@/components/admin-shell";
import { CycleBattery } from "@/components/cycle-battery";
import type { CyclesBillingConfig, DatabaseCycleEntry, DatabaseCyclesPendingPurchase, DatabaseMember, DatabaseRole, DatabaseSummary, MarketCreateListingRequest, MarketEntitlement, MarketListing, MarketUpdateListingRequest } from "@/lib/types";
import {
  deleteDatabaseAuthenticated,
  getCyclesBillingConfig,
  grantDatabaseAccessAuthenticated,
  listDatabaseCycleEntries,
  listDatabaseCyclesPendingPurchasesAuthenticated,
  listDatabaseMembersAuthenticated,
  listDatabaseMembersPublic,
  listDatabasesAuthenticated,
  listDatabasesPublic,
  marketCountActiveEntitlements,
  marketCreateListing,
  marketListDatabaseEntitlements,
  marketListDatabaseListings,
  marketPauseListing,
  marketPublishListing,
  marketUpdateListing,
  renameDatabaseAuthenticated,
  revokeDatabaseAccessAuthenticated
} from "@/lib/vfs-client";

type LoadState = "idle" | "loading" | "ready" | "error";
type DatabaseAccessSummary = DatabaseSummary & { publicReadable: boolean };
const CYCLES_HISTORY_LIMIT = 100;
const MARKET_ENTITLEMENTS_LIMIT = 100;

export function DashboardDatabaseClient({ databaseId }: { databaseId: string }) {
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const router = useRouter();
  const refreshSeqRef = useRef(0);
  const cyclesHistorySeqRef = useRef(0);
  const { authClient, authReady, principal } = useAppSession();
  const [databases, setDatabases] = useState<DatabaseAccessSummary[]>([]);
  const [cyclesConfig, setCyclesBillingConfig] = useState<CyclesBillingConfig | null>(null);
  const [members, setMembers] = useState<DatabaseMember[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionTone, setActionTone] = useState<"error" | "info">("info");
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [activeTab, setActiveTab] = useState<DashboardTab>("access");
  const [cycleEntries, setCycleEntries] = useState<DatabaseCycleEntry[]>([]);
  const [cycleEntriesError, setCycleEntriesError] = useState<string | null>(null);
  const [cycleEntriesLoading, setCycleEntriesLoading] = useState(false);
  const [cycleNextCursor, setCycleNextCursor] = useState<string | null>(null);
  const [pendingPurchases, setPendingPurchases] = useState<DatabaseCyclesPendingPurchase[]>([]);
  const [pendingPurchasesError, setPendingPurchasesError] = useState<string | null>(null);
  const [pendingPurchasesLoading, setPendingPurchasesLoading] = useState(false);
  const [marketListings, setMarketListings] = useState<MarketListing[]>([]);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketEntitlements, setMarketEntitlements] = useState<MarketEntitlement[]>([]);
  const [marketEntitlementsError, setMarketEntitlementsError] = useState<string | null>(null);
  const [marketEntitlementsLoading, setMarketEntitlementsLoading] = useState(false);
  const [marketEntitlementsNextCursor, setMarketEntitlementsNextCursor] = useState<string | null>(null);
  const [activeEntitlementCount, setActiveEntitlementCount] = useState<string | null>(null);
  const [marketBusy, setMarketBusy] = useState(false);

  const database = useMemo(() => databases.find((item) => item.databaseId === databaseId) ?? null, [databaseId, databases]);
  const isActiveDatabase = database?.status === "active";
  const canManage = database?.role === "owner" && isActiveDatabase && !memberError;
  const canDeletePendingDatabase = database?.role === "owner" && database.status === "pending";
  const canManageSettings = canManage || canDeletePendingDatabase;
  const canViewCyclesHistory = (database?.role === "writer" || database?.role === "owner") && isActiveDatabase;
  const showDashboardTabs = Boolean(databaseId && (database || principal));

  const resetCyclesHistoryState = useCallback(() => {
    setCycleEntries([]);
    setCycleEntriesError(null);
    setCycleEntriesLoading(false);
    setCycleNextCursor(null);
    setPendingPurchases([]);
    setPendingPurchasesError(null);
    setPendingPurchasesLoading(false);
  }, []);

  const refresh = useCallback(
    async (client: AuthClient | null, nextDatabaseId: string) => {
      const refreshSeq = (refreshSeqRef.current += 1);
      const isCurrentRefresh = () => refreshSeq === refreshSeqRef.current;
      if (!canisterId) {
        setError("NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is not configured.");
        setLoadState("error");
        return;
      }
      if (!nextDatabaseId) {
        setDatabases([]);
        setCyclesBillingConfig(null);
        setMembers([]);
        setMarketListings([]);
        setMarketError(null);
        setMarketEntitlements([]);
        setMarketEntitlementsError(null);
        setMarketEntitlementsLoading(false);
        setMarketEntitlementsNextCursor(null);
        setActiveEntitlementCount(null);
        setError(null);
        setWarning(null);
        setMemberError(null);
        resetCyclesHistoryState();
        setLoadState("ready");
        return;
      }
      setLoadState("loading");
      setError(null);
      setWarning(null);
      setMemberError(null);
      try {
        const identity = client?.getIdentity() ?? null;
        const [cyclesResult, publicResult, memberResult] = await Promise.allSettled([
          getCyclesBillingConfig(canisterId),
          listDatabasesPublic(canisterId),
          identity ? listDatabasesAuthenticated(canisterId, identity) : Promise.resolve<DatabaseSummary[]>([])
        ]);
        if (publicResult.status === "rejected" && !identity) {
          throw new Error(errorMessage(publicResult.reason));
        }
        if (publicResult.status === "rejected" && memberResult.status === "rejected") {
          throw new Error(`${errorMessage(publicResult.reason)}; ${errorMessage(memberResult.reason)}`);
        }
        const publicDatabases = publicResult.status === "fulfilled" ? publicResult.value : [];
        const memberDatabases = memberResult.status === "fulfilled" ? memberResult.value : [];
        const nextDatabases = mergeDatabaseRows(memberDatabases, publicDatabases);
        if (!isCurrentRefresh()) return;
        const nextDatabase = nextDatabases.find((item) => item.databaseId === nextDatabaseId) ?? null;
        setDatabases(nextDatabases);
        setCyclesBillingConfig(cyclesResult.status === "fulfilled" ? cyclesResult.value : null);
        setMembers([]);
        setMarketListings([]);
        setMarketError(null);
        setMarketEntitlements([]);
        setMarketEntitlementsError(null);
        setMarketEntitlementsLoading(false);
        setMarketEntitlementsNextCursor(null);
        setActiveEntitlementCount(null);
        if (publicResult.status === "rejected") {
          setWarning(`Public database list unavailable: ${errorMessage(publicResult.reason)}`);
        }
        if (memberResult.status === "rejected") {
          setMemberError(`Member database list unavailable: ${errorMessage(memberResult.reason)}`);
        }
        if (identity && nextDatabase?.role === "owner") {
          if (nextDatabase.status === "active") {
            const [membersResult, listingsResult, entitlementCountResult, entitlementsResult] = await Promise.allSettled([
              listDatabaseMembersAuthenticated(canisterId, identity, nextDatabaseId),
              marketListDatabaseListings(canisterId, identity, nextDatabaseId),
              marketCountActiveEntitlements(canisterId, identity, nextDatabaseId),
              marketListDatabaseEntitlements(canisterId, identity, nextDatabaseId, null, MARKET_ENTITLEMENTS_LIMIT)
            ]);
            if (!isCurrentRefresh()) return;
            if (membersResult.status === "fulfilled") {
              setMembers(membersResult.value);
            } else {
              setMemberError(errorMessage(membersResult.reason));
            }
            if (listingsResult.status === "fulfilled") {
              setMarketListings(listingsResult.value);
            } else {
              setMarketError(errorMessage(listingsResult.reason));
            }
            if (entitlementCountResult.status === "fulfilled") {
              setActiveEntitlementCount(entitlementCountResult.value);
            } else {
              setMarketError((current) => [current, errorMessage(entitlementCountResult.reason)].filter(Boolean).join("; "));
            }
            if (entitlementsResult.status === "fulfilled") {
              setMarketEntitlements(entitlementsResult.value.entitlements);
              setMarketEntitlementsNextCursor(entitlementsResult.value.nextCursor);
            } else {
              setMarketEntitlementsError(errorMessage(entitlementsResult.reason));
            }
          }
        } else if (nextDatabase?.publicReadable && nextDatabase.status === "active") {
          try {
            const nextMembers = await listDatabaseMembersPublic(canisterId, nextDatabaseId);
            if (!isCurrentRefresh()) return;
            setMembers(nextMembers);
          } catch (cause) {
            if (!isCurrentRefresh()) return;
            setMemberError(errorMessage(cause));
          }
        }
        if (!isCurrentRefresh()) return;
        setLoadState("ready");
      } catch (cause) {
        if (!isCurrentRefresh()) return;
        setError(errorMessage(cause));
        setLoadState("error");
      }
    },
    [canisterId, resetCyclesHistoryState]
  );

  const loadCyclesHistory = useCallback(
    async (append: boolean, cursor: string | null) => {
      if (!canisterId || !databaseId) return;
      if (append && !cursor) return;
      const requestSeq = (cyclesHistorySeqRef.current += 1);
      const isCurrentRequest = () => requestSeq === cyclesHistorySeqRef.current;
      const identity = principal && authClient ? authClient.getIdentity() : null;
      await Promise.resolve();
      if (!isCurrentRequest()) return;
      setCycleEntriesLoading(true);
      setCycleEntriesError(null);
      if (!append) {
        setCycleEntries([]);
        setCycleNextCursor(null);
        setPendingPurchases([]);
        setPendingPurchasesError(null);
        setPendingPurchasesLoading(Boolean(identity));
      }
      try {
        const entriesPromise = listDatabaseCycleEntries(canisterId, databaseId, cursor, CYCLES_HISTORY_LIMIT, identity ?? undefined);
        const pendingPromise = identity ? listDatabaseCyclesPendingPurchasesAuthenticated(canisterId, identity, databaseId) : Promise.resolve<DatabaseCyclesPendingPurchase[]>([]);
        const [entriesResult, pendingResult] = await Promise.allSettled([entriesPromise, pendingPromise]);
        if (!isCurrentRequest()) return;
        if (entriesResult.status === "fulfilled") {
          setCycleEntries((current) => append ? [...current, ...entriesResult.value.entries] : entriesResult.value.entries);
          setCycleNextCursor(entriesResult.value.nextCursor);
        } else {
          setCycleEntriesError(errorMessage(entriesResult.reason));
        }
        if (!append && identity) {
          if (pendingResult.status === "fulfilled") {
            setPendingPurchases(pendingResult.value);
            setPendingPurchasesError(null);
          } else {
            setPendingPurchases([]);
            setPendingPurchasesError(errorMessage(pendingResult.reason));
          }
        }
      } finally {
        if (isCurrentRequest()) {
          setCycleEntriesLoading(false);
          setPendingPurchasesLoading(false);
        }
      }
    },
    [authClient, canisterId, databaseId, principal]
  );

  useEffect(() => {
    if (!authReady) return;
    const timer = window.setTimeout(() => {
      void refresh(principal && authClient ? authClient : null, databaseId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [authClient, authReady, databaseId, principal, refresh]);

  useEffect(() => {
    if (activeTab !== "cycles-history") return;
    if (!canViewCyclesHistory) return;
    const timer = window.setTimeout(() => {
      void loadCyclesHistory(false, null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTab, canViewCyclesHistory, databaseId, loadCyclesHistory, principal]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((activeTab === "list" || activeTab === "buyers") && !canManage) {
        setActiveTab("access");
        return;
      }
      if (activeTab === "cycles-history" && !canViewCyclesHistory) {
        setActiveTab("access");
        return;
      }
      if (activeTab === "settings" && !canManageSettings) {
        setActiveTab("access");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTab, canManage, canManageSettings, canViewCyclesHistory]);

  async function grantAccess(principalText: string, role: DatabaseRole) {
    if (!authClient || !databaseId) return;
    setBusy(true);
    setBusyAction({ kind: "grant", principalText, role });
    setActionMessage(null);
    try {
      await grantDatabaseAccessAuthenticated(canisterId, authClient.getIdentity(), databaseId, principalText, role);
      setActionTone("info");
      setActionMessage("Access updated.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setActionTone("error");
      setActionMessage(errorMessage(cause));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function revokeAccess(principalText: string) {
    if (!authClient || !databaseId) return;
    setBusy(true);
    setBusyAction({ kind: "revoke", principalText });
    setActionMessage(null);
    try {
      await revokeDatabaseAccessAuthenticated(canisterId, authClient.getIdentity(), databaseId, principalText);
      setActionTone("info");
      setActionMessage("Access revoked.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setActionTone("error");
      setActionMessage(errorMessage(cause));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function renameDatabase(name: string): Promise<boolean> {
    if (!authClient || !databaseId) return false;
    setBusy(true);
    setBusyAction({ kind: "rename" });
    setActionMessage(null);
    try {
      await renameDatabaseAuthenticated(canisterId, authClient.getIdentity(), databaseId, name);
      setActionTone("info");
      setActionMessage("Database name updated.");
      await refresh(authClient, databaseId);
      return true;
    } catch (cause) {
      setActionTone("error");
      setActionMessage(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  function openRenameDialog() {
    if (!database || !canManage) return;
    setRenameDraft(database.name);
    setRenameOpen(true);
  }

  async function submitRename(name: string) {
    if (!database || busy) return;
    const nextName = name.trim();
    if (!nextName || nextName === database.name) return;
    if (await renameDatabase(nextName)) {
      setRenameOpen(false);
    }
  }

  async function deleteDatabase(): Promise<string | null> {
    if (!authClient || !databaseId) return "Login with Internet Identity to delete database.";
    if (!database) return "Database summary unavailable.";
    setBusy(true);
    setBusyAction({ kind: "delete" });
    setActionMessage(null);
    try {
      await deleteDatabaseAuthenticated(canisterId, authClient.getIdentity(), {
        databaseId
      });
      router.replace("/dashboard");
      return null;
    } catch (cause) {
      const message = errorMessage(cause);
      setBusy(false);
      setBusyAction(null);
      return message;
    }
  }

  async function createMarketListing(request: MarketCreateListingRequest) {
    if (!authClient || !databaseId) return;
    setMarketBusy(true);
    setActionMessage(null);
    try {
      await marketCreateListing(canisterId, authClient.getIdentity(), request);
      setActionTone("info");
      setActionMessage("Listing published.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setMarketError(errorMessage(cause));
    } finally {
      setMarketBusy(false);
    }
  }

  async function updateMarketListing(request: MarketUpdateListingRequest) {
    if (!authClient || !databaseId) return;
    setMarketBusy(true);
    setActionMessage(null);
    try {
      await marketUpdateListing(canisterId, authClient.getIdentity(), request);
      setActionTone("info");
      setActionMessage("Listing updated.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setMarketError(errorMessage(cause));
    } finally {
      setMarketBusy(false);
    }
  }

  async function publishMarketListing(listingId: string) {
    if (!authClient || !databaseId) return;
    setMarketBusy(true);
    setActionMessage(null);
    try {
      await marketPublishListing(canisterId, authClient.getIdentity(), listingId);
      setActionTone("info");
      setActionMessage("Listing published.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setMarketError(errorMessage(cause));
    } finally {
      setMarketBusy(false);
    }
  }

  async function pauseMarketListing(listingId: string) {
    if (!authClient || !databaseId) return;
    setMarketBusy(true);
    setActionMessage(null);
    try {
      await marketPauseListing(canisterId, authClient.getIdentity(), listingId);
      setActionTone("info");
      setActionMessage("Listing paused.");
      await refresh(authClient, databaseId);
    } catch (cause) {
      setMarketError(errorMessage(cause));
    } finally {
      setMarketBusy(false);
    }
  }

  async function loadMoreMarketEntitlements() {
    if (!authClient || !databaseId || !marketEntitlementsNextCursor) return;
    setMarketEntitlementsLoading(true);
    setMarketEntitlementsError(null);
    try {
      const page = await marketListDatabaseEntitlements(canisterId, authClient.getIdentity(), databaseId, marketEntitlementsNextCursor, MARKET_ENTITLEMENTS_LIMIT);
      setMarketEntitlements((current) => [...current, ...page.entitlements]);
      setMarketEntitlementsNextCursor(page.nextCursor);
    } catch (cause) {
      setMarketEntitlementsError(errorMessage(cause));
    } finally {
      setMarketEntitlementsLoading(false);
    }
  }

  return (
    <AdminContent>
        <DatabaseDetailHeader
          title={database?.name ?? "Database access"}
          actions={<CycleBattery cyclesBalance={database?.cyclesBalance ?? null} />}
        />

        {error ? <StatusPanel tone="error" message={error} /> : null}
        {warning ? <StatusPanel tone="info" message={warning} /> : null}
        {actionMessage ? <StatusPanel tone={actionTone} message={actionMessage} /> : null}
        {renameOpen && database ? (
          <RenameDatabaseDialog
            busy={busy}
            busyAction={busyAction}
            databaseName={database.name}
            draft={renameDraft}
            onCancel={() => setRenameOpen(false)}
            onChange={setRenameDraft}
            onSubmit={(name) => void submitRename(name)}
          />
        ) : null}

        {databaseId && (database || principal) ? <SummaryPanel cyclesConfig={cyclesConfig} database={database} databaseId={databaseId} publicReadable={database?.publicReadable ?? false} /> : null}
        {showDashboardTabs ? <DashboardTabs activeTab={activeTab} canManageListings={canManage} canManageSettings={canManageSettings} canViewCyclesHistory={canViewCyclesHistory} onChange={setActiveTab} /> : null}

        {activeTab === "list" && showDashboardTabs && canManage && database ? (
          <MarketListingsPanel
            busy={marketBusy}
            databaseId={databaseId}
            databaseName={database.name}
            error={marketError}
            listings={marketListings}
            onCreate={createMarketListing}
            onPause={pauseMarketListing}
            onPublish={publishMarketListing}
            onUpdate={updateMarketListing}
          />
        ) : activeTab === "buyers" && showDashboardTabs && canManage ? (
          <BuyersPanel
            entitlements={marketEntitlements}
            error={marketEntitlementsError}
            loading={marketEntitlementsLoading}
            nextCursor={marketEntitlementsNextCursor}
            onLoadMore={() => void loadMoreMarketEntitlements()}
          />
        ) : activeTab === "cycles-history" && showDashboardTabs && canViewCyclesHistory ? (
          <CyclesHistoryPanel
            authenticated={Boolean(principal)}
            entries={cycleEntries}
            entriesError={cycleEntriesError}
            entriesLoading={cycleEntriesLoading}
            nextCursor={cycleNextCursor}
            pendingError={pendingPurchasesError}
            pendingLoading={pendingPurchasesLoading}
            pendingPurchases={pendingPurchases}
            onLoadMore={() => void loadCyclesHistory(true, cycleNextCursor)}
            onRefresh={() => void loadCyclesHistory(false, null)}
          />
        ) : activeTab === "settings" && showDashboardTabs && canManageSettings && database ? (
          <DashboardSettingsPanel
            activeEntitlementCount={activeEntitlementCount}
            busy={busy}
            busyAction={busyAction}
            canRename={canManage}
            cyclesBalance={database.cyclesBalance}
            databaseId={databaseId}
            databaseName={database.name}
            onDelete={deleteDatabase}
            onRename={openRenameDialog}
          />
        ) : database ? (
          canDeletePendingDatabase ? (
            <PendingDatabasePanel />
          ) : canManage ? (
            <OwnerPanel
              busy={busy}
              busyAction={busyAction}
              members={members}
              principal={principal ?? "anonymous"}
              onGrant={grantAccess}
              onRevoke={revokeAccess}
            />
          ) : database.publicReadable ? (
            <ReadonlyMembersPanel memberError={memberError} members={members} principal={principal ?? "anonymous"} />
          ) : principal ? (
            <StatusPanel tone="info" message={memberError ?? "No management permission for this database."} />
          ) : (
            <StatusPanel tone="info" message="Login with Internet Identity to manage database access." />
          )
        ) : principal ? (
          <StatusPanel tone="info" message={memberError ?? "Select Cycles History to inspect cycle visibility for this database."} />
        ) : (
          <section className="rounded-lg border border-line bg-paper p-8 shadow-sm">
            <p className="text-sm leading-6 text-muted">Public anonymous read is not available for this database. Login with Internet Identity to manage database access.</p>
          </section>
        )}
    </AdminContent>
  );
}

function DatabaseDetailHeader({ actions, title, titleAction }: { actions: ReactNode; title: string; titleAction?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="min-w-0 truncate text-3xl font-semibold text-ink">{title}</h1>
        {titleAction ? <div className="shrink-0">{titleAction}</div> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </header>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected error";
}

function mergeDatabaseRows(memberDatabases: DatabaseSummary[], publicDatabases: DatabaseSummary[]): DatabaseAccessSummary[] {
  const publicIds = new Set(publicDatabases.map((database) => database.databaseId));
  const rows = new Map<string, DatabaseAccessSummary>();
  for (const database of publicDatabases) {
    rows.set(database.databaseId, { ...database, publicReadable: true });
  }
  for (const database of memberDatabases) {
    rows.set(database.databaseId, { ...database, publicReadable: publicIds.has(database.databaseId) });
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name) || left.databaseId.localeCompare(right.databaseId));
}
