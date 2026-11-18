import { useId } from "react";
import { Button } from "./button";
import { Input } from "./input";

export type PaymentSource = {
  id: string;
  label: string;
  account: string | null;
  balanceLabel: string | null;
  connectionState: "connected" | "disconnected" | "remembered" | "grant" | "connecting";
  onConnect?: () => void;
  onDisconnect?: () => void;
  connectDisabled?: boolean;
};
type Action = {label: string; run: () => void; disabled?: boolean};
export type PaymentStatusProps = {
  phase: "editing" | "preparing" | "ready" | "approving" | "paying" | "checking" | "refreshing" | "complete" | "unresolved" | "failed";
  message?: string;
  balanceUnavailable?: boolean;
  recoveryActions?: Action[];
};
const progress = {
  editing: "", preparing: "Preparing payment", ready: "Review your payment", approving: "Approving",
  paying: "Paying", checking: "Checking payment", refreshing: "Updating balance", complete: "Payment complete",
  unresolved: "Payment needs a status check", failed: "Payment needs attention"
};
export function PaymentStatus({phase, message, balanceUnavailable, recoveryActions}: PaymentStatusProps) {
  return <>
    <output aria-live="polite" aria-atomic="true" className="grid gap-1 break-words text-sm">
      {progress[phase] && <strong>{progress[phase]}</strong>}
      {message && <span>{message}</span>}
      {balanceUnavailable && <span>Balance unavailable. Your payment was confirmed.</span>}
    </output>
    {recoveryActions?.map(action => <Button key={action.label} variant="outline" type="button" disabled={action.disabled} onClick={action.run}>{action.label}</Button>)}
  </>;
}

export function FundingSource({label, account, balanceLabel, connectionState, onConnect, onDisconnect, connectDisabled, disabled}:
  Omit<PaymentSource, "id"> & {disabled?: boolean}) {
  const connectLabel = connectionState === "remembered" ? "Reconnect" : connectionState === "grant" ? "Authorize" : "Connect";
  return <div className="grid min-w-0 gap-2 text-sm">
    {account && <span className="break-all font-mono text-xs">{account}</span>}
    {balanceLabel && <span>Balance · {balanceLabel}</span>}
    {onConnect && connectionState !== "connected" &&
      <Button type="button" variant="outline" disabled={disabled || connectDisabled || connectionState === "connecting"} onClick={onConnect}>{connectLabel} {label}</Button>}
    {onDisconnect && connectionState === "connected" &&
      <Button type="button" variant="outline" disabled={disabled} onClick={onDisconnect}>Disconnect {label}</Button>}
  </div>;
}
export type PaymentFormProps = {
  sources: PaymentSource[]; selectedSource: string; targetLabel: string; amount: string;
  summary?: {amount: string; transferFee: string; approvalFee: string; approvalPaid?: boolean;
    total: string; remaining?: string; credit: string; details: {label: string; value: string}[]};
  status: PaymentStatusProps;
  actions: {onSource: (id: string) => void; onAmount: (amount: string) => void; onReview: () => void; onPay: () => void;
    canReview: boolean; canPay: boolean; locked?: boolean; amountError?: string};
};
export function PaymentForm({sources, selectedSource, targetLabel, amount, summary, status, actions}: PaymentFormProps) {
  const group = useId();
  const busy = ["preparing","approving","paying","checking","refreshing"].includes(status.phase);
  const locked = busy || !!actions.locked;
  const source = sources.find(item => item.id === selectedSource);
  const rows = summary && [
    ["Amount", summary.amount + " KINIC"], ["Transfer fee", summary.transferFee + " KINIC"],
    [summary.approvalPaid ? "Approval fee (paid)" : "Approval fee", summary.approvalFee + " KINIC"],
    ["Total debit", summary.total + " KINIC"], ...(summary.remaining ? [["Remaining debit", summary.remaining + " KINIC"]] : []),
    ["Expected credit", summary.credit],
  ];
  return <div className="grid min-w-0 gap-4">
    <fieldset className="grid min-w-0 gap-3 rounded-lg border border-line p-3">
      <legend className="px-1 text-sm font-semibold">Payment source</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {sources.map(item => <label key={item.id} className="inline-flex min-h-10 items-center gap-2 text-sm">
          <input type="radio" name={group} checked={selectedSource === item.id} disabled={locked} onChange={() => actions.onSource(item.id)} />
          {item.label}
        </label>)}
      </div>
      {source && <FundingSource {...source} disabled={locked} />}
    </fieldset>
    <p className="break-words text-sm">Credit to <strong>{targetLabel}</strong></p>
    <label htmlFor={`${group}-amount`} className="grid gap-1 text-sm font-medium">KINIC amount
      <Input id={`${group}-amount`} inputMode="decimal" autoComplete="off" value={summary?.amount ?? amount} disabled={locked || !!summary}
        onChange={event => actions.onAmount(event.target.value)} />
    </label>
    {actions.amountError && <p role="alert" className="text-sm">{actions.amountError}</p>}
    {summary && <>
      <dl className="grid gap-2 rounded-lg border border-line p-3 text-sm">
        {rows?.map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-x-3"><dt>{label}</dt><dd className="font-medium">{value}</dd></div>)}
      </dl>
      <details className="min-w-0 text-sm"><summary className="cursor-pointer">Payment details</summary>
        <dl className="grid gap-2 pt-2">{summary.details.map(({label,value}) =>
          <div key={label}><dt>{label}</dt><dd className="break-all font-mono text-xs">{value}</dd></div>)}</dl>
      </details>
    </>}
    {status.phase === "ready" ? <Button type="button" disabled={!actions.canPay || !summary} onClick={actions.onPay}>Pay {summary?.amount ?? amount} KINIC</Button>
      : (status.phase === "editing" || (status.phase === "failed" && !summary)) &&
        <Button type="button" disabled={!actions.canReview} onClick={actions.onReview}>Review payment</Button>}
    <PaymentStatus {...status} />
  </div>;
}
