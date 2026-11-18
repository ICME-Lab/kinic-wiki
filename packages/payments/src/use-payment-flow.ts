import { useLayoutEffect, useRef, useState } from "react";
import { formatKinicExact } from "./amounts";
import { createPaymentController, type PaymentController, type PaymentControllerState } from "./controller";
import { classifyPaymentFailure, formatPaymentFailure } from "./errors";
import { createRecoveryStore, type RecoveryStore } from "./recovery-store";
import type { PaymentAdapter } from "./types";

export function browserRecoveryStore() {
  // Access to localStorage itself can throw in browsers with storage disabled.
  return createRecoveryStore({
    getItem: key => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: key => window.localStorage.removeItem(key),
  });
}
export type FlowBinding = {store: RecoveryStore; isCurrent: () => boolean};
export function usePaymentFlow<C, A extends PaymentAdapter<C>>(
  factory: (binding: FlowBinding) => A | null,
  manager: {capture(): unknown; isCurrent(token: unknown): boolean} | null,
) {
  const [store] = useState(browserRecoveryStore);
  const [state, setState] = useState<PaymentControllerState>({phase: "editing"});
  const [checked, setChecked] = useState(false);
  const [approvalPaid, setApprovalPaid] = useState(false);
  const active = useRef<{adapter: A; controller: PaymentController<C>; isCurrent(): boolean} | null>(null);
  useLayoutEffect(() => {
    let live = true;
    const token = manager?.capture();
    const isCurrent = () => live && !!manager?.isCurrent(token);
    setState({phase: "editing"});
    setChecked(false);
    setApprovalPaid(false);
    try {
      const adapter = manager && factory({store, isCurrent});
      if (!adapter) return;
      const controller = createPaymentController<C>({adapter, store, guard: {capture: () => token, isCurrent},
        onState(next) {
          if (!isCurrent()) return;
          if (next.phase === "editing" || next.phase === "preparing") setApprovalPaid(false);
          if (next.phase !== "complete" && next.phase !== "refreshing") {
            try {
              if (store.list(adapter.scope)[0]?.stage === "approved") setApprovalPaid(true);
            } catch { /* The controller reports storage failures. */ }
          }
          setState(next);
        },
      });
      active.current = {controller, adapter, isCurrent};
      setState(controller.getState());
      return () => {
        live = false;
        active.current = null;
        controller.destroy();
        if ("destroy" in adapter && typeof adapter.destroy === "function") adapter.destroy();
      };
    } catch (error) {
      setState({phase:"failed", error: classifyPaymentFailure("preparing", error)});
    }
    return () => { live = false; };
  }, [factory, manager, store]);
  async function check() {
    const binding = active.current;
    setChecked(false);
    await binding?.controller.check();
    if (binding?.isCurrent()) setChecked(true);
  }
  return {active, state, checked, check, store, approvalPaid};
}

// Turn validated controller data into display values without exposing adapter context.
export function paymentPresentation(state: PaymentControllerState, approvalPaid: boolean, checked: boolean,
  creditLabel: (value: bigint) => string) {
  const p = state.summary;
  const approvalFee = p && (p.approvalRequired || approvalPaid) ? p.approvalFeeE8s : 0n;
  const summary = p && {
    amount: formatKinicExact(p.amountE8s), credit: creditLabel(p.credits), transferFee: formatKinicExact(p.transferFeeE8s),
    approvalFee: formatKinicExact(approvalFee), approvalPaid,
    total: formatKinicExact(p.amountE8s + p.transferFeeE8s + approvalFee),
    remaining: approvalPaid ? formatKinicExact(p.amountE8s + p.transferFeeE8s) : undefined,
    details: [
      {label: "Payment ID", value: p.id}, {label: "Payer", value: p.scope.payer.owner},
      {label: "Credit target", value: p.scope.target.kind === "wiki" ? p.scope.target.databaseId : p.scope.target.beneficiary},
      {label: "Ledger", value: p.scope.ledger}, {label: "Spender", value: p.scope.spender}, {label: "Recipient", value: p.recipient},
      {label: "Allowance (e8s)", value: p.allowanceE8s.toString()}, {label: "Raw cycles", value: p.credits.toString()},
      ...(p.expiresAtNs === null ? [] : [{label:"Expiry (nanoseconds)", value:p.expiresAtNs.toString()}]),
    ],
  };
  let message = state.error && formatPaymentFailure(state.error, state.phase === "unresolved" ? "unresolved" : "failed");
  if (state.receipt) {
    message = `Credited ${creditLabel(state.receipt.creditedCycles)}. Reference ${state.receipt.reference}.`;
    if (state.balance !== undefined) message += ` Current balance: ${creditLabel(state.balance)}.`;
    if (state.error && state.error.stage !== "refreshing") message += " " + formatPaymentFailure(state.error);
  } else if (checked && state.phase === "ready") message = "Status checked. This payment is still unpaid.";
  else if (state.requiredAction === "review") message = (message ? message + " " : "") + "Review the original payment before continuing.";
  else if (state.phase === "unresolved" && !message) message = "Check the original payment to see whether it completed.";
  return {summary, status: {phase:state.phase, message, balanceUnavailable:state.balanceUnavailable}};
}

export type SourceId = "ii" | "oisy" | "plug";
export function useFundingProvider(preferenceKey: string, connected?: SourceId) {
  const [choice, setChoice] = useState<SourceId | null>(() => {
    try {
      const saved = localStorage.getItem(preferenceKey);
      return saved === "ii" || saved === "oisy" || saved === "plug" ? saved : null;
    } catch { return null; }
  });
  const select = (id: string) => {
    if (id !== "ii" && id !== "oisy" && id !== "plug") return;
    setChoice(id);
    try { localStorage.setItem(preferenceKey, id); } catch { /* In-memory selection still works. */ }
  };
  return {source: choice ?? connected ?? "ii", select};
}
export function fundingSources(options: {
  identity: string | null; external: {provider: SourceId; owner: string} | null;
  state: string; granted: boolean; balance(provider: SourceId): string | null;
  connect(provider: "oisy" | "plug"): void; disconnect(provider: "oisy" | "plug"): void;
}) {
  return (["ii","oisy","plug"] as const).map(id => {
    const external = id !== "ii" && options.external?.provider === id;
    const account = id === "ii" ? options.identity : external ? options.external?.owner ?? null : null;
    const connectionState = id === "ii" ? (account ? "connected" : "disconnected")
      : !external ? "disconnected" : options.state === "connected" ? options.granted ? "connected" : "grant"
      : options.state === "connecting" ? "connecting" : "remembered";
    return {id, label: id === "ii" ? "Internet Identity" : id === "oisy" ? "OISY" : "Plug",
      account, balanceLabel: options.balance(id), connectionState,
      onConnect: id === "ii" ? undefined : () => options.connect(id),
      onDisconnect: id === "ii" ? undefined : () => options.disconnect(id),
    } as const;
  });
}
