import { classifyPaymentFailure, PaymentFailure } from "./errors";
import { recoveryTargetKey, samePaymentScope, type RecoveryStore } from "./recovery-store";
import { normalizePaymentScope } from "./terms";
import type {
  PaymentAdapter, PaymentCheck, PaymentErrorCode, PaymentPhase, PaymentReceipt,
  PaymentSummary, PaymentViewState, PreparedPayment, RecoveryRecord,
} from "./types";

export type PaymentControllerState = PaymentViewState & {
  requiredAction?: "check" | "review";
  reference?: string;
  canCancelUnsubmitted?: true;
};

export type PaymentLocks = {
  request(name: string, options: { ifAvailable: true }, run: (lock: object | null) => Promise<void>): Promise<void>;
};

export type PaymentControllerOptions<C> = {
  adapter: PaymentAdapter<C>;
  store: RecoveryStore;
  guard: { capture(): unknown; isCurrent(token: unknown): boolean };
  nowNs?: () => bigint;
  onState?: (state: PaymentControllerState) => void;
  locks?: PaymentLocks | null;
};

function summary<C>({ context: _context, ...visible }: PreparedPayment<C>): PaymentSummary {
  return visible;
}

function dispatchPhase(stage: RecoveryRecord["stage"]): PaymentPhase {
  if (stage === "quote-dispatched") return "preparing";
  if (stage === "approval-dispatched") return "approving";
  return "paying";
}

export function createPaymentController<C>({
  adapter, guard, store, nowNs = () => BigInt(Date.now()) * 1_000_000n,
  onState, locks = globalThis.navigator?.locks ?? null,
}: PaymentControllerOptions<C>) {
  const scope = normalizePaymentScope(adapter.scope);
  const token = guard.capture();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let state: PaymentControllerState = { phase: "editing" };
  let prepared: PreparedPayment<C> | null = null;
  let record: RecoveryRecord | null = null;
  let receiptOperationId: string | null = null;
  let destroyed = false;
  let busy = false;

  function current() {
    return !destroyed && guard.isCurrent(token) && samePaymentScope(scope, adapter.scope);
  }

  function publish(next: PaymentControllerState) {
    if (!current()) return;
    state = next;
    onState?.(state);
  }

  function stopChecks() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  function scheduleChecks() {
    stopChecks();
    if (!adapter.capabilities.silentCheck || !current()) return;
    for (const delay of [0, 1000, 3000]) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (current() && adapter.capabilities.silentCheck && state.phase === "unresolved") void checkPayment(true);
        else if (!current()) stopChecks();
      }, delay);
      timers.add(timer);
    }
  }

  function journal() {
    if (store.hasTargetConflict(scope)) throw new PaymentFailure("AccountChanged");
    return store.list(scope)[0] ?? null;
  }

  function unresolved(stage: PaymentPhase, code: PaymentErrorCode, review = false) {
    publish({
      phase: "unresolved", summary: prepared ? summary(prepared) : undefined,
      error: { stage, code }, requiredAction: review ? "review" : "check",
    });
  }

  function fail(stage: PaymentPhase, error: unknown, unsubmitted?: PreparedPayment<C>) {
    if (!current()) return;
    let failure = classifyPaymentFailure(stage, error);
    if (stage === "refreshing" && state.receipt) {
      publish({ ...state, phase: "complete", balanceUnavailable: true, error: failure });
      return;
    }
    if (state.receipt) {
      publish({ ...state, phase: "complete", error: failure });
      return;
    }
    try {
      record = journal();
    } catch (readError) {
      prepared = null;
      record = null;
      failure = classifyPaymentFailure(stage, readError);
      unresolved(stage, failure.code, true);
      return;
    }
    if (unsubmitted && record?.id === unsubmitted.id && (record.stage === "quote-dispatched" || record.stage === "approved")) {
      publish({ phase: "failed", error: failure, summary: summary(unsubmitted), requiredAction: "check" });
    } else if (record || failure.code === "StorageUnavailable") {
      unresolved(stage, failure.code, failure.code === "StorageUnavailable" || failure.code === "InvalidReply");
    } else {
      publish({ phase: "failed", error: failure, summary: prepared ? summary(prepared) : undefined });
    }
  }

  // Claim synchronously before the platform lock request or any wallet promise.
  // ifAvailable keeps a competing confirmation from executing later on release.
  async function run(stage: PaymentPhase, writes: boolean, action: () => Promise<void>) {
    if (busy || !current()) return;
    busy = true;
    try {
      if (!locks) {
        if (writes) throw new PaymentFailure("CoordinationUnavailable");
        await action();
      } else {
        await locks.request(recoveryTargetKey(scope), { ifAvailable: true }, async lock => {
          if (!current()) return;
          if (!lock) throw new PaymentFailure("Unavailable");
          await action();
        });
      }
    } catch (error) {
      fail(stage, error);
    } finally {
      busy = false;
    }
  }

  function persist(p: PreparedPayment<C>, stage: RecoveryRecord["stage"]) {
    const next: RecoveryRecord = { version: 1, scope, id: p.id, stage, context: adapter.encode(p) };
    store.put(next);
    record = next;
  }

  function clear(r: RecoveryRecord) {
    store.remove(scope, r.id);
    record = null;
    stopChecks();
  }

  function cleanConfirmedReceipt(saved: RecoveryRecord | null) {
    if (!state.receipt || (saved && saved.id !== receiptOperationId)) return false;
    // The backend already confirmed this exact operation. Retry local cleanup
    // without consulting another signer or weakening the receipt.
    try {
      if (saved) clear(saved);
      if (state.error?.stage === "complete" || state.error?.stage === "checking") {
        const { error: _cleanupError, ...complete } = state;
        publish(complete);
      }
    } catch (error) {
      publish({ ...state, error: classifyPaymentFailure("complete", error) });
    }
    return true;
  }

  function expired(p: PreparedPayment<C>) {
    return p.expiresAtNs !== null && nowNs() >= p.expiresAtNs;
  }

  function validateSnapshot(p: PreparedPayment<C>, id?: string) {
    if (!p.id || !p.termsKey || !samePaymentScope(scope, p.scope) || (id !== undefined && p.id !== id))
      throw new PaymentFailure("InvalidReply");
  }

  async function prepare(amountE8s: bigint) {
    if (state.phase === "unresolved") return;
    await run("preparing", true, async () => {
      const saved = journal();
      if (saved) {
        if (cleanConfirmedReceipt(saved)) return;
        if (state.phase === "failed" && state.requiredAction === "check"
          && saved.id === record?.id && saved.stage === record.stage) return;
        record = saved;
        prepared = null;
        unresolved(dispatchPhase(saved.stage), "Unknown");
        scheduleChecks();
        return;
      }
      prepared = null;
      record = null;
      publish({ phase: "preparing" });
      if (!current()) return;
      try {
        if (amountE8s <= 0n) throw new PaymentFailure("InvalidReply");
        const p = await adapter.prepare(amountE8s);
        if (!current()) return;
        record = journal(); // Vault may have journaled before quote_purchase.
        validateSnapshot(p, record?.id);
        if (p.amountE8s !== amountE8s || (record && record.stage !== "quote-dispatched"))
          throw new PaymentFailure("InvalidReply");
        prepared = p;
        if (expired(p)) throw new PaymentFailure("Expired");
        publish({ phase: "ready", summary: summary(p) });
      } catch (error) {
        fail("preparing", error, prepared ?? undefined);
        if (record && state.phase === "unresolved") scheduleChecks();
      }
    });
  }

  async function validateBeforeDispatch(p: PreparedPayment<C>, stage: PaymentPhase) {
    try {
      if (expired(p)) throw new PaymentFailure("Expired");
      if (await adapter.revalidate(p) !== "unchanged") throw new PaymentFailure("TermsChanged");
      if (expired(p)) throw new PaymentFailure("Expired");
      return true;
    } catch (error) {
      // This read stopped the next dispatch. Only an actual lost dispatch
      // puts the original operation into uncertain-outcome recovery.
      fail(stage, error, p);
      return false;
    }
  }

  async function refresh(receipt: PaymentReceipt, visible?: PaymentSummary) {
    const complete = { phase: "complete", summary: visible, receipt } as const;
    publish({ ...complete, phase: "refreshing" });
    if (!current()) return;
    try {
      const balance = await adapter.refreshCredit();
      publish({ ...complete, balance });
    } catch (error) {
      publish({ ...complete, balanceUnavailable: true, error: classifyPaymentFailure("refreshing", error) });
    }
  }

  async function handleResult(result: PaymentCheck, r: RecoveryRecord, silentOnly = false) {
    if (!current()) return;
    const visible = prepared ? summary(prepared) : undefined;
    switch (result.kind) {
      case "paid": {
        stopChecks();
        receiptOperationId = r.id;
        // A storage or balance failure cannot undo an authoritative receipt.
        // A surviving marker is reconciled against the backend on reload.
        let cleanupError: unknown;
        try {
          store.put({ ...r, stage: "paid" });
          record = { ...r, stage: "paid" };
          clear(r);
        } catch (error) { cleanupError = error; }
        if (silentOnly && !adapter.capabilities.silentCheck)
          publish({ phase: "complete", receipt: result.receipt, summary: visible, balanceUnavailable: true });
        else await refresh(result.receipt, visible);
        if (cleanupError && current() && !state.error)
          publish({ ...state, error: classifyPaymentFailure("complete", cleanupError) });
        return;
      }
      case "rejected":
        clear(r);
        publish({ phase: "failed", summary: visible, error: { stage: dispatchPhase(r.stage), code: result.code } });
        return;
      case "pending":
        publish({
          phase: "unresolved", summary: visible, requiredAction: result.requiredAction, reference: result.reference,
          error: state.error,
        });
        return;
      case "unsubmitted": {
        // A Quoted status doesn't disprove an in-flight purchase or a lost
        // ledger approval. Keep the marker until the adapter has stronger proof.
        if (r.stage !== "quote-dispatched" && r.stage !== "approved") {
          unresolved(dispatchPhase(r.stage), "Unknown", true);
          return;
        }
        if (silentOnly && !adapter.capabilities.silentCheck) {
          unresolved(dispatchPhase(r.stage), "Unknown");
          return;
        }
        const p = await adapter.restore(r);
        if (!current()) return;
        if (!p) throw new PaymentFailure("InvalidReply");
        validateSnapshot(p, r.id);
        prepared = p;
        stopChecks();
        const stale = result.expired || expired(p);
        publish({
          phase: stale ? "failed" : "ready", summary: summary(p),
          ...(stale ? { error: { stage: "ready", code: "Expired" } as const } : {}),
          ...(adapter.capabilities.cancelUnsubmitted && adapter.cancel ? { canCancelUnsubmitted: true } as const : {}),
        });
        return;
      }
    }
  }

  async function pay(confirmedTermsKey: string) {
    const p = prepared;
    if (state.phase !== "ready" || !p || confirmedTermsKey !== p.termsKey) return;
    await run("ready", true, async () => {
      const saved = journal();
      if (saved?.id !== record?.id || saved?.stage !== record?.stage
        || (saved && saved.stage !== "approved" && saved.stage !== "quote-dispatched")) {
        prepared = null;
        record = saved;
        fail("ready", new PaymentFailure("AccountChanged"));
        return;
      }
      const needsApproval = p.approvalRequired && saved?.stage !== "approved";
      let stage: PaymentPhase = needsApproval ? "approving" : "paying";
      try {
        publish({ phase: stage, summary: summary(p) });
        if (!current()) return;
        if (!await validateBeforeDispatch(p, stage) || !current()) return;
        if (needsApproval) {
          persist(p, "approval-dispatched");
          try {
            await adapter.approve(p);
          } catch (error) {
            if (!current()) return;
            const failure = classifyPaymentFailure("approving", error);
            if (["ApprovalRejected", "InsufficientFunds", "BadFee", "AllowanceChanged", "Expired"].includes(failure.code)) {
              // A definitive ledger refusal did not apply the approval. Keep
              // the original Vault quote available for explicit investigation.
              if (saved) {
                store.put(saved, { approvalRejected: true });
                record = saved;
              }
              else clear(record!);
              publish({ phase: "failed", summary: summary(p), error: failure });
              return;
            }
            throw error;
          }
          if (!current()) return;
          persist(p, "approved");
          stage = "paying";
          publish({ phase: stage, summary: summary(p) });
          if (!current()) return;
          if (!await validateBeforeDispatch(p, stage) || !current()) return;
        }
        persist(p, "purchase-dispatched");
        const result = await adapter.submit(p);
        if (!current()) return;
        await handleResult(result, record!);
        if (current() && state.phase === "unresolved") scheduleChecks();
      } catch (error) {
        fail(stage, error);
        if (record) scheduleChecks();
      }
    });
  }

  async function checkPayment(silentOnly: boolean) {
    await run("checking", false, async () => {
      if (silentOnly && !adapter.capabilities.silentCheck) return;
      const saved = journal();
      if (cleanConfirmedReceipt(saved)) return;
      if (!saved) {
        prepared = null;
        record = null;
        stopChecks();
        if (!state.receipt) publish({ phase: "editing" });
        return;
      }
      if (prepared?.id !== saved.id) prepared = null;
      const previousError = record?.id === saved.id && state.error?.stage === dispatchPhase(saved.stage)
        ? state.error : undefined;
      record = saved;
      publish({ phase: "checking", summary: prepared ? summary(prepared) : undefined, error: previousError });
      if (!current()) return;
      const result = await adapter.check(saved);
      if (!current()) return;
      if (saved.stage === "approval-dispatched" && result.kind === "unsubmitted") {
        // Only the adapter can correlate authoritative approval history. It
        // records that evidence before reporting the purchase unsubmitted.
        const latest = journal();
        if (latest?.id !== saved.id) throw new PaymentFailure("AccountChanged");
        record = latest;
      }
      await handleResult(result, record, silentOnly);
    });
  }

  async function cancelUnsubmitted() {
    const p = prepared;
    if (!state.canCancelUnsubmitted || !p || !adapter.cancel || !adapter.capabilities.cancelUnsubmitted) return;
    await run("checking", true, async () => {
      const saved = journal();
      if (!saved || saved.id !== p.id || (saved.stage !== "approved" && saved.stage !== "quote-dispatched")) {
        throw new PaymentFailure("AccountChanged");
      }
      publish({ phase: "checking", summary: summary(p) });
      if (!current()) return;
      const result = await adapter.check(saved);
      if (!current()) return;
      if (result.kind !== "unsubmitted") return handleResult(result, saved);
      await adapter.cancel!(p);
      if (!current()) return;
      clear(saved);
      prepared = null;
      publish({ phase: "editing" });
    });
  }

  async function refreshBalance() {
    const { receipt, summary: visible } = state;
    if (receipt) await run("refreshing", false, () => refresh(receipt, visible));
  }

  try {
    record = journal();
    if (record) {
      unresolved(dispatchPhase(record.stage), "Unknown");
      scheduleChecks();
    }
  } catch (error) { fail("checking", error); }

  return {
    prepare, pay, check: () => checkPayment(false), refreshBalance, cancelUnsubmitted, getState: () => state,
    destroy() { destroyed = true; stopChecks(); },
  };
}

export type PaymentController<C> = ReturnType<typeof createPaymentController<C>>;
