"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";

export type FundingSourceChoice = "ii" | "wallet";

export type FundingAccount = {
  available: boolean;
  balance: string | null;
  balanceError: string | null;
  balanceLoading: boolean;
  label: string;
  principal: string | null;
  refreshDisabled: boolean;
  onRefresh: () => void;
};

export function KinicFundingSourceSelector({
  identityAccount,
  onSelect,
  requiredBalanceE8s,
  selected,
  selectionDisabled = false,
  walletAccount
}: {
  identityAccount: FundingAccount;
  onSelect: (choice: FundingSourceChoice) => void;
  requiredBalanceE8s: bigint;
  selected: FundingSourceChoice;
  selectionDisabled?: boolean;
  walletAccount: FundingAccount;
}) {
  const requiredBalanceLabel = formatTokenAmountFromE8s(requiredBalanceE8s);
  return (
    <fieldset className="grid gap-3 rounded-lg border border-line bg-white p-3 text-sm">
      <legend className="px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Payment source</legend>
      <FundingAccountOption
        account={walletAccount}
        choice="wallet"
        onSelect={onSelect}
        requiredBalanceE8s={requiredBalanceE8s}
        requiredBalanceLabel={requiredBalanceLabel}
        selected={selected === "wallet"}
        selectionDisabled={selectionDisabled}
      />
      <FundingAccountOption
        account={identityAccount}
        choice="ii"
        onSelect={onSelect}
        requiredBalanceE8s={requiredBalanceE8s}
        requiredBalanceLabel={requiredBalanceLabel}
        selected={selected === "ii"}
        selectionDisabled={selectionDisabled}
      />
      <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="text-muted">Required balance</span>
        <span className="font-mono font-semibold text-ink">{requiredBalanceLabel}</span>
      </div>
    </fieldset>
  );
}

function FundingAccountOption({
  account,
  choice,
  onSelect,
  requiredBalanceE8s,
  requiredBalanceLabel,
  selected,
  selectionDisabled
}: {
  account: FundingAccount;
  choice: FundingSourceChoice;
  onSelect: (choice: FundingSourceChoice) => void;
  requiredBalanceE8s: bigint;
  requiredBalanceLabel: string;
  selected: boolean;
  selectionDisabled: boolean;
}) {
  const balanceLabel = fundingBalanceLabel(account);
  const sufficient = balanceCanFund(account.balance, requiredBalanceE8s);
  return (
    <div className={`grid gap-2 rounded-lg border p-3 ${selected ? "border-action bg-action/5" : "border-line bg-paper"}`}>
      <label className={`flex items-start gap-3 ${account.available ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}>
        <input
          checked={selected}
          className="mt-1"
          disabled={!account.available || selectionDisabled}
          name="kinic-funding-source"
          type="radio"
          value={choice}
          onChange={() => onSelect(choice)}
        />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-ink">{account.label}</span>
          <span className="block truncate font-mono text-xs text-muted" title={account.principal ?? undefined}>
            {account.principal ? shortPrincipal(account.principal) : choice === "wallet" ? "Not connected" : "Not signed in"}
          </span>
        </span>
        <span className="shrink-0 font-mono text-xs text-ink">{balanceLabel}</span>
      </label>
      {selected && account.available && account.balance !== null && !account.balanceError && !account.balanceLoading && !sufficient ? (
        <p className="text-xs leading-5 text-red-700">This account needs at least {requiredBalanceLabel}.</p>
      ) : null}
      {selected && account.balanceError ? <p className="text-xs leading-5 text-red-700">{account.balanceError}</p> : null}
      {selected && !account.available && choice === "wallet" ? (
        <p className="text-xs leading-5 text-muted">Connect OISY or Plug from the header to use its KINIC balance.</p>
      ) : null}
      {selected ? (
        <button
          className="inline-flex items-center justify-center rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          disabled={account.refreshDisabled}
          type="button"
          onClick={account.onRefresh}
        >
          {account.balanceLoading ? "Refreshing..." : "Refresh balance"}
        </button>
      ) : null}
    </div>
  );
}

export function useFundingSourceChoice(walletAvailable: boolean, walletSessionReady: boolean) {
  const initializedRef = useRef(walletSessionReady);
  const [selected, setSelected] = useState<FundingSourceChoice>(walletSessionReady && walletAvailable ? "wallet" : "ii");
  const [manuallySelected, setManuallySelected] = useState(false);

  useEffect(() => {
    if (!initializedRef.current && walletSessionReady) {
      initializedRef.current = true;
      if (!manuallySelected) setSelected(walletAvailable ? "wallet" : "ii");
      return;
    }
    if (selected === "wallet" && !walletAvailable) {
      setSelected("ii");
    }
  }, [manuallySelected, selected, walletAvailable, walletSessionReady]);

  const select = useCallback((choice: FundingSourceChoice) => {
    setManuallySelected(true);
    setSelected(choice);
  }, []);

  const reset = useCallback(() => {
    setManuallySelected(false);
    setSelected(walletAvailable ? "wallet" : "ii");
  }, [walletAvailable]);

  return { reset, select, selected };
}

export function balanceCanFund(balanceE8s: string | null, requiredE8s: bigint): boolean {
  if (!balanceE8s || !/^\d+$/.test(balanceE8s)) return false;
  return BigInt(balanceE8s) >= requiredE8s;
}

function fundingBalanceLabel(account: FundingAccount): string {
  if (!account.available) return "Not connected";
  if (account.balanceLoading) return "Loading...";
  if (account.balanceError || account.balance === null) return "Unavailable";
  return formatTokenAmountFromE8s(account.balance);
}

function shortPrincipal(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
