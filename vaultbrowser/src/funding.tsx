import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { VaultClient } from "@kinic/vault-client";
import type { FundingConfig, Payment, ReconciliationProgress } from "@kinic/vault-candid";
import { formatKinicExact, parseKinic } from "@kinic/payments/amounts";
import { classifyPaymentFailure, formatPaymentFailure, PaymentFailure } from "@kinic/payments/errors";
import { readLedgerTerms } from "@kinic/payments/ledger";
import { browserRecoveryStore, fundingSources, paymentPresentation, useFundingProvider, usePaymentFlow,
  type FlowBinding, type SourceId } from "@kinic/payments/use-payment-flow";
import { PaymentForm } from "@kinic/ui/payment-form";
import { formatCycles } from "@kinic/ui/cycles";
import { createVaultPaymentAdapter, decodeVaultRecoveryRecord, discoverVaultFundingConfig, listVaultFundingHistory, readVaultHistoryStatus, vaultFundingScopes } from "./funding/adapter";
import { inspectVaultHistory, readOnlyStatusLabel, savedVaultLedger } from "./funding/history";
import { isPendingPayment, paymentId, paymentStatusLabel } from "./funding/payments";
import { useVaultFundingSession } from "./funding/session";

type Props = {client: VaultClient; onFunded: () => Promise<void>};
const creditLabel = (cycles: bigint) => formatCycles(cycles) + " cycles";
export function Funding({client, onFunded}: Props) {
  const {session, snapshot} = useVaultFundingSession();
  const choice = useFundingProvider("kinic.vault.payment-source", snapshot?.account?.provider);
  const [paymentAttempt, setPaymentAttempt] = useState(0);
  if (!session || !snapshot) return <section className="vault-funding"><h3>Add prepaid balance</h3><p>Funding is unavailable.</p></section>;
  return <VaultPayment key={JSON.stringify([client.identity.getPrincipal().toText(), choice.source, snapshot.generation, client.session.capture(), paymentAttempt])}
    client={client} onFunded={onFunded} source={choice.source} select={choice.select} session={session} snapshot={snapshot}
    onNewPayment={() => setPaymentAttempt(attempt => attempt + 1)}/>;
}

type Environment = ReturnType<typeof useVaultFundingSession>;
function VaultPayment({client, onFunded, source, select, session, snapshot, onNewPayment}: Props & {
  onNewPayment: () => void;
  source:SourceId; select:(id:string)=>void; session: NonNullable<Environment["session"]>; snapshot: NonNullable<Environment["snapshot"]>
}) {
  const {manager, config} = session;
  const [amount, setAmount] = useState("1");
  const [funding, setFunding] = useState<FundingConfig | null>();
  const [history, setHistory] = useState<Payment[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [balance, setBalance] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ReconciliationProgress>();
  const stopScan = useRef(false);
  const [store] = useState(browserRecoveryStore);
  const beneficiary = client.identity.getPrincipal().toText();
  const external = snapshot.account?.provider !== "ii" ? snapshot.account : null;
  const owner = source === "ii" ? beneficiary : external?.provider === source ? external.owner : null;
  const identity = client.identity;
  const lifecycle = useRef<() => boolean>(() => false);
  useLayoutEffect(() => {
    let live = true;
    const token = manager.capture(), generation = client.session.capture();
    lifecycle.current = () => live && manager.isCurrent(token) && client.session.capture() === generation &&
      client.identity.getPrincipal().toText() === beneficiary;
    return () => { live = false; stopScan.current = true; };
  }, [manager,client,beneficiary]);
  const [journal, setJournal] = useState<{ledger?: string; error?: string}>();
  useLayoutEffect(() => {
    try { setJournal({ledger:owner ? savedVaultLedger(config,{provider:source,owner},beneficiary,store) : undefined}); }
    catch { setJournal({error:"The payment record could not be saved or read."}); }
  }, [config,source,owner,beneficiary,store]);
  useEffect(() => {
    let live = true;
    void discoverVaultFundingConfig(config).then(value => {if (live) setFunding(value);})
      .catch(() => {if (live) setFunding(null);});
    return () => {live = false;};
  }, [config]);
  const chosen = history?.find(item => paymentId(item) === selectedId) ?? history?.[0];
  const ledger = journal?.ledger ?? chosen?.config.ledger.toText() ?? funding?.ledger.toText();
  let journalId: string | undefined;
  let journalAmount: string | undefined;
  let storageError = journal?.error;
  if (!storageError && ledger && owner) {
    try {
      const original = store.list({host:config.host, origin:location.origin, spender:config.canister, ledger,
        payer:{provider:source,owner}, target:{kind:"vault",beneficiary}})[0];
      if (original) {
        journalId = original.id;
        journalAmount = formatKinicExact(decodeVaultRecoveryRecord(original,original.scope).request.amount_e8s);
      }
    } catch { storageError = "The payment record could not be saved or read."; }
  }
  const scopes = vaultFundingScopes(config.canister,ledger);
  const granted = manager.hasScopes(scopes);
  const connected = source === "ii" ? !!manager.getIdentityTransport(scopes)
    : !!external && external.provider === source && snapshot.state === "connected" && granted;
  const historyGranted = manager.hasScopes(vaultFundingScopes(config.canister));
  const authorizedPlug = source === "plug" && historyGranted ? snapshot.transport : undefined;
  const create = useCallback(({store, isCurrent}: FlowBinding) => {
    if (!connected || funding === undefined || !journal || journal.error || (!ledger && config.local)) return null;
    return createVaultPaymentAdapter({config, fundingConfig:funding, recoveryLedger:ledger, source, beneficiaryIdentity:identity,
      walletSession:manager, authorizedPlug, isCurrent:() => lifecycle.current() && isCurrent(), store, ownerClient:client});
  }, [connected, funding,journal, ledger, config,source,identity,manager,authorizedPlug,client]);
  const flowSession = useMemo(() => ({capture: manager.capture,
    isCurrent: (token: unknown) => lifecycle.current() && manager.isCurrent(token)}), [manager]);
  const flow = usePaymentFlow(create,flowSession);
  const {state} = flow;
  // A reviewed summary remains the operation the user can see, even if another
  // tab replaces the durable slot before this component renders again.
  const displayedId = state.summary?.id ?? journalId ?? (chosen && paymentId(chosen));
  const selected = displayedId ? history?.find(p => paymentId(p) === displayedId) : chosen;
  const presentation = paymentPresentation(state,flow.approvalPaid,flow.checked,creditLabel);
  const lastReceipt = useRef<string | undefined>(undefined);
  useEffect(() => {
    const ref = state.receipt?.reference;
    if (state.phase === "complete" && ref && lastReceipt.current !== ref) {
      lastReceipt.current = ref;
      void onFunded().catch(() => { if (lifecycle.current()) setNotice("Workspace balance unavailable. Your payment was confirmed."); });
    }
  }, [state,onFunded]);

  const loadHistory = useCallback(async () => {
    const current = lifecycle.current;
    if (!current()) return;
    setReading(true);
    try {
      const payments = await listVaultFundingHistory({config,source,walletSession:manager,authorizedPlug,
        beneficiaryIdentity:identity,isCurrent:current});
      if (current()) {
        setHistory(payments.filter(isPendingPayment).sort((a,b) => Number("Quoted" in a.status) - Number("Quoted" in b.status)));
        setNotice("");
      }
    } catch { if (current()) setNotice("Could not load previous payments. Check payment history before funding."); }
    finally { if (current()) setReading(false); }
  }, [config,source,manager,authorizedPlug,identity]);
  const canList = source === "ii" ? connected : external?.provider === source && snapshot.state === "connected" && historyGranted;
  useEffect(() => { if (canList && source !== "oisy") void loadHistory(); }, [canList,source,loadHistory]);
  const paymentComplete = state.phase === "complete";
  useEffect(() => {
    let live = true;
    if (connected && ledger && owner) {
      void readLedgerTerms({host:config.host,ledger,owner,spender:config.canister}).then(terms => {
        if (live) setBalance(formatKinicExact(terms.balanceE8s) + " KINIC");
      }).catch(() => { if (live) setBalance("Unavailable"); });
    }
    return () => {live = false;};
  }, [connected,config,ledger,owner,paymentComplete]);
  // A settled disabled configuration can still authorize history on the Vault.
  // While discovery is pending, its ledger is unknown and a grant would be incomplete.
  const plugGrantReady = funding !== undefined && !!journal;
  const sources = fundingSources({identity:beneficiary,external,state:snapshot.state,granted,
    balance:id => id === source ? balance : null, connect:id => {
      if (id === "plug" && !plugGrantReady) return;
      const result = manager.connect(id,scopes);
      void result.catch(() => { if (lifecycle.current()) setNotice("Wallet connection failed. Connect the selected wallet to continue."); });
    },disconnect:() => { void manager.disconnect().catch(() => setNotice("Could not disconnect the wallet.")); }}).map(item => ({
      ...item, connectDisabled: item.id === "plug" && !plugGrantReady,
    }));
  const check = async () => {
    if (storageError && selected && canList && !reading) {
      const current = lifecycle.current;
      setReading(true);
      try {
        const result = await readVaultHistoryStatus({config,source,walletSession:manager,
          authorizedPlug:source === "plug" ? snapshot.transport : undefined,beneficiaryIdentity:identity,isCurrent:current},selected);
        if (current()) setNotice(readOnlyStatusLabel(result));
      } catch (error) {
        if (current()) setNotice(formatPaymentFailure(classifyPaymentFailure("checking",error)));
      } finally { if (current()) setReading(false); }
      return;
    }
    const binding = flow.active.current;
    if (!binding) return;
    setNotice("");
    try {
      const original = flow.store.list(binding.adapter.scope)[0];
      if (original && displayedId && original.id !== displayedId) throw new PaymentFailure("AccountChanged");
      if (selected && !original) {
        const result = await inspectVaultHistory(binding.adapter,flow.store,selected,binding.isCurrent);
        if (!binding.isCurrent()) return;
        if (result) { setNotice(result); return; }
      }
      await flow.check(displayedId);
      if (binding.isCurrent() && binding.controller.getState().phase === "complete") setHistory([]);
    } catch(error) { if (binding.isCurrent()) setNotice(formatPaymentFailure(classifyPaymentFailure("checking",error))); }
  };
  const scan = async () => {
    const binding = flow.active.current;
    if (!binding || scanning) return;
    const current = binding.isCurrent;
    setScanning(true); setNotice(""); stopScan.current = false;
    try {
      const record = flow.store.list(binding.adapter.scope)[0] ?? (selected && binding.adapter.recordFor(selected));
      if (!record) return;
      if (displayedId && record.id !== displayedId) throw new PaymentFailure("AccountChanged");
      // Each OISY gesture permits a single batch. Silent transports may continue up to ten.
      for (let batch = 0; batch < (binding.adapter.capabilities.silentCheck ? 10 : 1); batch++) {
        if (!current() || stopScan.current) break;
        const result = await binding.adapter.scan(record);
        if (!current() || stopScan.current) break;
        setProgress(result);
        if ("Paid" in result.payment.status) { await check(); break; }
        if (!result.can_continue) break;
      }
    } catch(error) { if (current()) setNotice(formatPaymentFailure(classifyPaymentFailure("checking",error))); }
    finally { if (current()) setScanning(false); }
  };
  const busy = reading || scanning || ["preparing","paying","approving","checking","refreshing"].includes(state.phase);
  const enabled = !storageError && !!flow.active.current?.adapter.fundingEnabled;
  let amountE8s: bigint | undefined;
  try {amountE8s = parseKinic(amount);} catch { /* Inline correction below. */ }
  const actions = [];
  if ((state.phase === "complete" || state.phase === "failed") && !state.balanceUnavailable && !state.cleanupPending && flow.active.current) {
    const binding = flow.active.current;
    try {
      // A terminal result permits a fresh operation only after its durable marker
      // is cleared. Uncertain dispatches and failed cleanup stay recoverable.
      if (!flow.store.hasTargetConflict(binding.adapter.scope) && !flow.store.list(binding.adapter.scope).length)
        actions.push({label:"New payment",disabled:busy,run:() => {
          try {
            if (binding.isCurrent() && !flow.store.hasTargetConflict(binding.adapter.scope)
              && !flow.store.list(binding.adapter.scope).length) onNewPayment();
          } catch(error) { setNotice(formatPaymentFailure(classifyPaymentFailure("checking",error))); }
        }});
    } catch { /* Preserve the controller's storage recovery state. */ }
  }
  const hasHistory = !!selected && state.phase !== "complete";
  if (canList && !busy && !hasHistory && !state.summary && state.phase !== "complete")
    actions.push({label:"Check payment history",run:() => { void loadHistory(); }});
  if (((hasHistory || state.phase === "unresolved" || !!state.summary || state.phase === "failed") && state.phase !== "complete")
    || (state.phase === "complete" && state.cleanupPending))
    actions.push({label:"Check payment status",disabled:busy || (!flow.active.current && !(storageError && selected && canList)),run:() => { void check(); }});
  if (!storageError && state.canCancelUnsubmitted)
    actions.push({label:"Cancel unpaid payment",disabled:busy,run:async () => {
      const binding = flow.active.current;
      await binding?.controller.cancelUnsubmitted();
      if (binding?.isCurrent() && binding.controller.getState().phase === "editing") {
        setProgress(undefined); await loadHistory(); setNotice("Unpaid payment cancelled. Any existing ledger allowance remains active.");
      }
    }});
  if (state.balanceUnavailable) actions.push({label:"Refresh credit balance",run:() => {void flow.active.current?.controller.refreshBalance();}});
  const cursor = progress && paymentId(progress.payment) === displayedId ? progress : selected?.reconciliation[0];
  if (!storageError && (state.phase === "unresolved" || (selected && ("Unknown" in selected.status || "InFlight" in selected.status)))) {
    actions.push({label:cursor ? "Resume ledger scan" : "Scan ledger for this payment",
      disabled:busy || !flow.active.current,run:() => { void scan(); }});
  }
  if (scanning) actions.push({label:"Stop ledger scan",run:() => {stopScan.current = true;}});
  return <section className="vault-funding">
    <h3>Add prepaid balance</h3>
    {config.fundingMode === "synthetic-test-only" && <p className="vault-notice">Synthetic test funding. No real KINIC is used.</p>}
    {funding === null && <p className="vault-notice vault-notice--warn">Funding is unavailable. You can still check existing payments.</p>}
    {storageError && <p role="alert">{storageError}</p>}
    {snapshot.reason && !connected && <output>Wallet connection requires attention ({snapshot.reason}).</output>}
    {history && history.length > 1 && <label>Saved payment<select value={displayedId ?? ""} disabled={!!journalId || busy || state.phase !== "editing"}
      onChange={event => {setSelectedId(event.target.value); setProgress(undefined);}}>{journalId && !selected && <option value={journalId}>{journalId}</option>}{history.map(p =>
        <option key={paymentId(p)} value={paymentId(p)}>{paymentId(p)} · {paymentStatusLabel(p)}</option>)}</select></label>}
    {journalId && !selected && !state.summary && <p className="break-all text-sm">Original payment · {journalId}</p>}
    {hasHistory && selected && !state.summary && <p className="break-all text-sm">{paymentStatusLabel(selected)} · {paymentId(selected)}</p>}
    <PaymentForm sources={sources} selectedSource={source} amount={state.summary ? formatKinicExact(state.summary.amountE8s) : journalAmount ?? (hasHistory && selected ? formatKinicExact(selected.request.amount_e8s) : amount)}
      targetLabel={`Vault prepaid account · ${beneficiary}`} summary={presentation.summary}
      status={{...presentation.status,recoveryActions:actions}} actions={{onSource:select,onAmount:setAmount,locked:busy || state.phase === "ready",
        canPay:enabled && connected && !busy,onPay:() => {if (state.summary) void flow.active.current?.controller.pay(state.summary.termsKey);},
        canReview:enabled && connected && !busy && !!amountE8s && !hasHistory && (source === "oisy" || !!history),
        onReview:() => {if (amountE8s) void flow.active.current?.controller.prepare(amountE8s);},
        amountError:!amountE8s ? "Enter a positive KINIC amount with up to 8 decimal places." : undefined}}/>
    {cursor && <output aria-live="polite">Ledger scan: next {cursor.next.toString()} of {cursor.end.toString()}.</output>}
    {notice && <output>{notice}</output>}
  </section>;
}
