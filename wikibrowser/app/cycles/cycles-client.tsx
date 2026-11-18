"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { formatKinicExact, parseKinic } from "@kinic/payments/amounts";
import { fundingSources, paymentPresentation, useFundingProvider, usePaymentFlow, type FlowBinding } from "@kinic/payments/use-payment-flow";
import { PaymentForm } from "@kinic/ui/payment-form";
import { formatCycles } from "@kinic/ui/cycles";
import { useAppSession } from "@/app/app-session-provider";
import { AdminContent } from "@/components/admin-shell";
import { AdminNotice, AdminPanel } from "@/components/admin-ui";
import { useAppNavigate } from "@/lib/app-router";
import { databaseCyclesHref, databaseCyclesView } from "@/lib/cycles-state";
import { parseCyclesTarget } from "@/lib/cycles-url";
import { createWikiBillingClient, createWikiCyclesPaymentAdapter } from "@/lib/payments/cycles-adapter";
import type { CyclesBillingConfig, DatabaseStatus, DatabaseSummary } from "@/lib/types";
import { getCyclesBillingConfig, listDatabasesAuthenticated } from "@/lib/vfs-client";

const creditLabel = (value: bigint) => formatCycles(value) + " cycles";
type Props = {canisterId: string; databaseId: string; databaseStatus: DatabaseStatus | null};
export function CyclesClient({canisterId, databaseId, databaseStatus}: Props) {
  const router = useAppNavigate();
  const session = useAppSession();
  const {authClient, principal, walletSession, walletSnapshot, walletPaymentReady, setAuthControlsLocked, setWalletControlsLocked} = session;
  const {source, select} = useFundingProvider("kinic.wiki.payment-source", walletSnapshot.account?.provider);
  const [amount, setAmount] = useState("1");
  const [data, setData] = useState<{auth: typeof authClient; principal: string | null; canisterId: string; databases: DatabaseSummary[]; config: CyclesBillingConfig}>();
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let current = true;
    setLoadError("");
    if (canisterId) {
      const databases = authClient && principal ? listDatabasesAuthenticated(canisterId, authClient.getIdentity()) : Promise.resolve([]);
      void Promise.all([databases, getCyclesBillingConfig(canisterId)])
        .then(([databases, config]) => { if (current) setData({auth:authClient, principal, canisterId, databases, config}); })
        .catch(() => { if (current) setLoadError("Could not load linked databases and billing terms."); });
    }
    return () => { current = false; };
  }, [authClient, principal, canisterId]);
  const currentData = data?.auth === authClient && data?.principal === principal && data?.canisterId === canisterId ? data : undefined;
  const configured = !!canisterId && canisterId === import.meta.env.VITE_KINIC_WIKI_CANISTER_ID;
  const target = parseCyclesTarget(new URLSearchParams({database_id:databaseId}));
  const validTarget = !!target && typeof target !== "string";
  const fundable = currentData?.databases.filter(db => databaseCyclesView(db, currentData.config).purchaseAvailable) ?? [];
  const selected = fundable.find(db => db.databaseId === databaseId);
  const linkedTarget = currentData?.databases.find(db => db.databaseId === databaseId);
  // URL funding also supports unlinked databases. Block known deleted targets
  // from new dispatches while retaining their existing recovery controller.
  const availableTarget = (linkedTarget?.status ?? databaseStatus) !== "deleted";
  const ready = source === "ii" ? !!principal : walletSnapshot.account?.provider === source && walletPaymentReady;
  const generation = walletSnapshot.generation;
  const create = useCallback(({store, isCurrent}: FlowBinding) =>
    currentData && configured && validTarget && ready && walletSession.getSnapshot().generation === generation ?
      createWikiCyclesPaymentAdapter({store, isCurrent, canisterId, databaseId, authIdentity: principal ? authClient?.getIdentity() : undefined,
        walletSession, source, billingClient:createWikiBillingClient(currentData.config)}) : null,
    [authClient, canisterId, currentData, configured, databaseId, generation, principal, ready, source, validTarget, walletSession]);
  const flow = usePaymentFlow(create, walletSession);
  const {state, active} = flow;
  const {summary, status} = paymentPresentation(state, flow.approvalPaid, flow.checked, creditLabel);
  if (state.phase === "unresolved" && state.requiredAction === "review") {
    const reference = state.reference && /^\d+$/.test(state.reference) ? ` (operation ${state.reference})` : "";
    const authority = currentData?.config.billingAuthorityId;
    status.message = [flow.checked ? "Status checked." : "", state.error && state.error.code !== "Unknown" ? status.message : "",
      `Contact the Wiki billing authority${authority ? " " + authority : ""} to review the original payment${reference}.`].filter(Boolean).join(" ");
  }
  const busy = ["preparing","approving","paying","checking","refreshing"].includes(state.phase);
  const locked = busy || state.phase === "ready";
  useLayoutEffect(() => {
    setAuthControlsLocked(locked);
    setWalletControlsLocked(locked);
    return () => { setAuthControlsLocked(false); setWalletControlsLocked(false); };
  }, [locked, setAuthControlsLocked, setWalletControlsLocked]);
  const external = walletSnapshot.account?.provider !== "ii" ? walletSnapshot.account : null;
  const sources = fundingSources({identity:principal, external, state:walletSnapshot.state, granted:walletPaymentReady,
    balance: id => {
      const raw = id === "ii" ? session.identityLedgerBalance : id === external?.provider ? session.walletBalance : null;
      return raw && /^\d+$/.test(raw) ? formatKinicExact(BigInt(raw)) + " KINIC" : null;
    }, connect:session.connectWallet, disconnect:session.disconnectWallet});
  let amountE8s: bigint | undefined;
  try { amountE8s = parseKinic(amount); } catch { /* Display the input correction below. */ }
  const recoveryActions = [];
  if (state.phase === "unresolved" || state.phase === "failed" || state.phase === "ready"
    || (state.phase === "complete" && state.cleanupPending))
    recoveryActions.push({label: state.phase === "ready" && !flow.approvalPaid ? "Edit payment" : "Check payment status", run:() => { void flow.check(); }});
  if (state.balanceUnavailable) recoveryActions.push({label:"Refresh credit balance",run:() => { void active.current?.controller.refreshBalance(); }});
  if (state.phase === "complete") recoveryActions.push({label:"View database",run:() => {
    const params = new URLSearchParams({funding:"success",database_id:databaseId,provider:source,
      kinic:summary?.amount ?? amount, cycles:state.receipt?.creditedCycles.toLocaleString("en-US") ?? ""});
    router.replace("/dashboard?" + params.toString());
  }});
  const balanceError = source === "ii" ? session.identityLedgerBalanceError : session.walletBalanceError;
  return <AdminContent><div className="mx-auto grid w-full max-w-2xl gap-5 text-ink">
    <header><h1 className="text-2xl font-semibold">Top up cycles</h1>
      <p className="mt-1 text-sm text-muted">Pay with KINIC to keep a database writable.</p></header>
    {!principal ? <button data-tid="cycles-login-button" disabled={locked || !session.authReady || session.authLoading} type="button" onClick={session.login}>Sign in with Internet Identity</button> : null}
    {session.authError && <AdminNotice tone="error" message={session.authError}/>}
    <AdminPanel className="grid gap-4 bg-white" padding="md">
      <label className="grid gap-2 text-sm">Database<select className="min-h-10 rounded-lg border border-line px-3"
        disabled={locked || !fundable.length} value={selected?.databaseId ?? ""} onChange={event => {
          const db = fundable.find(item => item.databaseId === event.target.value);
          if (db) router.replace(databaseCyclesHref(db));
        }}><option value="">Select a database</option>{fundable.map(db => <option value={db.databaseId} key={db.databaseId}>
          {db.metadata.name} · {db.status} · {databaseCyclesView(db,currentData?.config ?? null).summary}</option>)}</select></label>
      {loadError && <AdminNotice tone="error" message={loadError}/>}
      {principal && currentData && !fundable.length && <AdminNotice tone="info" message="No fundable databases linked to this principal."/>}
      {(selected?.status ?? databaseStatus) === "pending" && <AdminNotice tone="info" message="This database becomes active after its first cycles purchase."/>}
      {!configured && <AdminNotice tone="error" message="Wiki billing is unavailable for this canister."/>}
      {balanceError && <AdminNotice tone="error" message={balanceError}/>}
      <PaymentForm sources={sources} selectedSource={source} targetLabel={selected?.metadata.name ?? (databaseId || "Select a database")}
        amount={amount} summary={summary} status={{...status,recoveryActions}} actions={{onSource:select,onAmount:setAmount,locked,
          canPay:!!active.current && availableTarget && ready && state.phase === "ready", onPay:() => { if (availableTarget && state.summary) void active.current?.controller.pay(state.summary.termsKey); },
          canReview:!!active.current && availableTarget && ready && !!amountE8s && !busy, onReview:() => { if (availableTarget && amountE8s) void active.current?.controller.prepare(amountE8s); },
          amountError:!amountE8s ? "Enter a positive KINIC amount with up to 8 decimal places." : undefined}} />
    </AdminPanel>
  </div></AdminContent>;
}
