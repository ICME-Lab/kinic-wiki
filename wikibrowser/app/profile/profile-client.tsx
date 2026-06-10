"use client";

// Where: /profile client UI.
// What: manages App KINIC deposits.
// Why: App balance is an internal balance, so the UI must separate it from wallet and ledger balances.
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Principal } from "@icp-sdk/core/principal";
import { useAppSession } from "@/app/app-session-provider";
import { AdminContent } from "@/components/admin-shell";
import { AdminField, AdminIconButton, AdminNotice, AdminPanel } from "@/components/admin-ui";
import { KINIC_LEDGER_FEE_E8S } from "@/lib/cycles";
import { parseKinicAmount } from "@/lib/kinic-deposit";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { depositKinicBalanceWithIdentity, getPrincipalKinicLedgerBalance } from "@/lib/kinic-wallet";
import { kinicGetBalance, kinicWithdrawBalance } from "@/lib/vfs-client";

type ProfileClientProps = {
  canisterId: string;
};

type DepositState = "idle" | "running" | "success" | "error";
type WithdrawState = "idle" | "running" | "success" | "error";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ProfileClient({ canisterId }: ProfileClientProps) {
  const {
    authClient,
    authLoading,
    authReady,
    kinicBalance,
    kinicBalanceError,
    kinicBalanceLoading,
    login,
    principal,
    refreshKinicBalance
  } = useAppSession();
  const [amount, setAmount] = useState("1");
  const [depositState, setDepositState] = useState<DepositState>("idle");
  const [depositMessage, setDepositMessage] = useState<string | null>(null);
  const [withdrawAmount, setWithdrawAmount] = useState("1");
  const [withdrawRecipient, setWithdrawRecipient] = useState("");
  const [withdrawState, setWithdrawState] = useState<WithdrawState>("idle");
  const [withdrawMessage, setWithdrawMessage] = useState<string | null>(null);
  const [profileBalance, setProfileBalance] = useState<string | null>(null);
  const [profileBalanceError, setProfileBalanceError] = useState<string | null>(null);
  const [principalLedgerBalance, setPrincipalLedgerBalance] = useState<string | null>(null);
  const [principalLedgerBalanceError, setPrincipalLedgerBalanceError] = useState<string | null>(null);
  const [principalLedgerBalanceLoading, setPrincipalLedgerBalanceLoading] = useState(false);
  const parsedAmount = useMemo(() => parseKinicAmount(amount), [amount]);
  const parsedWithdrawAmount = useMemo(() => parseKinicAmount(withdrawAmount), [withdrawAmount]);
  const parsedWithdrawRecipient = useMemo(() => parsePrincipalText(withdrawRecipient), [withdrawRecipient]);
  const amountError = parsedAmount ? null : "Enter an amount greater than 0 KINIC";
  const withdrawAmountError = parsedWithdrawAmount ? null : "Enter an amount greater than 0 KINIC";
  const withdrawRecipientError = withdrawRecipient.trim() ? (parsedWithdrawRecipient ? null : "Enter a valid recipient principal") : "Enter a recipient principal";
  const balance = profileBalance ?? kinicBalance;
  const balanceError = profileBalanceError ?? kinicBalanceError;
  const currentBalance = kinicBalanceLoading ? "Loading" : balance !== null ? formatTokenAmountFromE8s(balance) : "-";
  const principalLedgerBalanceLabel = principalLedgerBalanceLoading ? "Loading" : principalLedgerBalance !== null ? formatTokenAmountFromE8s(principalLedgerBalance) : "-";
  const principalLedgerBalanceE8s = parseE8sText(principalLedgerBalance);
  const totalDepositDebit = parsedAmount ? BigInt(parsedAmount) + KINIC_LEDGER_FEE_E8S * 2n : null;
  const maxDepositAmountE8s = principalLedgerBalanceE8s !== null && principalLedgerBalanceE8s > KINIC_LEDGER_FEE_E8S * 2n ? principalLedgerBalanceE8s - KINIC_LEDGER_FEE_E8S * 2n : 0n;
  const depositBalanceError =
    totalDepositDebit !== null && principalLedgerBalanceE8s !== null && principalLedgerBalanceE8s < totalDepositDebit
      ? `Deposit requires ${formatTokenAmountFromE8s(totalDepositDebit.toString())} in II principal balance.`
      : null;
  const balanceE8s = parseE8sText(balance);
  const maxWithdrawAmountE8s = balanceE8s !== null && balanceE8s > KINIC_LEDGER_FEE_E8S ? balanceE8s - KINIC_LEDGER_FEE_E8S : 0n;
  const totalWithdrawDebit = parsedWithdrawAmount ? BigInt(parsedWithdrawAmount) + KINIC_LEDGER_FEE_E8S : null;
  const depositBusy = depositState === "running";
  const withdrawBusy = withdrawState === "running";

  const loadProfile = useCallback(async () => {
    if (!authClient || !principal) {
      setProfileBalance(null);
      setProfileBalanceError(null);
      setPrincipalLedgerBalance(null);
      setPrincipalLedgerBalanceError(null);
      setPrincipalLedgerBalanceLoading(false);
      return;
    }
    setProfileBalanceError(null);
    setPrincipalLedgerBalanceError(null);
    setPrincipalLedgerBalanceLoading(true);
    const identity = authClient.getIdentity();
    const [appBalanceResult, ledgerBalanceResult] = await Promise.allSettled([
      kinicGetBalance(canisterId, identity),
      getPrincipalKinicLedgerBalance(canisterId, principal)
    ]);
    if (appBalanceResult.status === "fulfilled") {
      setProfileBalance(appBalanceResult.value.balanceE8s);
    } else {
      setProfileBalance(null);
      setProfileBalanceError(errorMessage(appBalanceResult.reason));
    }
    if (ledgerBalanceResult.status === "fulfilled") {
      setPrincipalLedgerBalance(ledgerBalanceResult.value);
    } else {
      setPrincipalLedgerBalance(null);
      setPrincipalLedgerBalanceError(errorMessage(ledgerBalanceResult.reason));
    }
    setPrincipalLedgerBalanceLoading(false);
  }, [authClient, canisterId, principal]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void loadProfile();
    });
    return () => {
      cancelled = true;
    };
  }, [loadProfile]);

  function updateAmount(event: ChangeEvent<HTMLInputElement>) {
    setAmount(event.target.value);
    setDepositMessage(null);
    if (depositState !== "running") setDepositState("idle");
  }

  function updateWithdrawAmount(event: ChangeEvent<HTMLInputElement>) {
    setWithdrawAmount(event.target.value);
    setWithdrawMessage(null);
    if (withdrawState !== "running") setWithdrawState("idle");
  }

  function updateWithdrawRecipient(event: ChangeEvent<HTMLInputElement>) {
    setWithdrawRecipient(event.target.value);
    setWithdrawMessage(null);
    if (withdrawState !== "running") setWithdrawState("idle");
  }

  function useMaxDepositAmount() {
    setAmount(formatKinicInputFromE8s(maxDepositAmountE8s));
    setDepositMessage(null);
    if (depositState !== "running") setDepositState("idle");
  }

  function useMaxWithdrawAmount() {
    setWithdrawAmount(formatKinicInputFromE8s(maxWithdrawAmountE8s));
    setWithdrawMessage(null);
    if (withdrawState !== "running") setWithdrawState("idle");
  }

  async function deposit() {
    if (!authClient || !principal) {
      await login();
      return;
    }
    if (!parsedAmount) {
      setDepositState("error");
      setDepositMessage(amountError);
      return;
    }
    if (depositBalanceError) {
      setDepositState("error");
      setDepositMessage(depositBalanceError);
      return;
    }
    setDepositState("running");
    setDepositMessage(null);
    try {
      const result = await depositKinicBalanceWithIdentity({ canisterId, amountE8s: BigInt(parsedAmount) }, authClient.getIdentity());
      setProfileBalance(result.balanceE8s);
      setDepositState("success");
      setDepositMessage(`Deposit block ${result.depositBlockIndex}. App balance ${formatTokenAmountFromE8s(result.balanceE8s)}`);
      await refreshKinicBalance();
      await loadProfile();
    } catch (cause) {
      setDepositState("error");
      setDepositMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function withdraw() {
    if (!authClient || !principal) {
      await login();
      return;
    }
    if (!parsedWithdrawAmount) {
      setWithdrawState("error");
      setWithdrawMessage(withdrawAmountError);
      return;
    }
    if (withdrawRecipientError || !parsedWithdrawRecipient) {
      setWithdrawState("error");
      setWithdrawMessage(withdrawRecipientError);
      return;
    }
    setWithdrawState("running");
    setWithdrawMessage(null);
    try {
      const result = await kinicWithdrawBalance(
        canisterId,
        authClient.getIdentity(),
        parsedWithdrawAmount,
        KINIC_LEDGER_FEE_E8S.toString(),
        parsedWithdrawRecipient
      );
      setProfileBalance(result.balanceE8s);
      setWithdrawState("success");
      setWithdrawMessage(`Withdraw block ${result.blockIndex}. App balance ${formatTokenAmountFromE8s(result.balanceE8s)}`);
      await refreshKinicBalance();
      await loadProfile();
    } catch (cause) {
      setWithdrawState("error");
      setWithdrawMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <AdminContent>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        {principal ? (
          <section className="grid gap-6">
            <AdminPanel className="grid gap-3 bg-white" padding="md">
              <AdminField label="Principal ID" value={principal} breakAll mono />
              <AdminField
                label="App KINIC balance"
                value={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-2xl font-semibold">{currentBalance}</span>
                    <AdminIconButton label="Refresh profile" onClick={() => void loadProfile()}>
                      <RefreshCw aria-hidden size={17} />
                    </AdminIconButton>
                  </span>
                }
              />
              {balanceError ? <AdminNotice tone="error" message={`App KINIC balance unavailable: ${balanceError}`} /> : null}
            </AdminPanel>

            <AdminPanel className="grid gap-3 bg-white" padding="md">
              <h2 className="text-lg font-semibold">Deposit KINIC</h2>
              <div className="flex flex-wrap gap-2">
                <div className="relative min-w-0 flex-1">
                  <input
                    className="min-h-11 w-full min-w-0 rounded-lg border border-line px-3 py-2 pr-20 font-mono text-sm outline-none focus:border-accent"
                    inputMode="decimal"
                    value={amount}
                    onChange={updateAmount}
                  />
                  <button
                    className="absolute right-2 top-1/2 min-h-8 -translate-y-1/2 rounded-md border border-line bg-paper px-3 text-xs font-semibold text-ink hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={depositBusy || principalLedgerBalanceLoading || maxDepositAmountE8s <= 0n}
                    type="button"
                    onClick={useMaxDepositAmount}
                  >
                    Max
                  </button>
                </div>
                <button
                  className="min-h-11 rounded-lg border border-action bg-action px-4 text-sm font-semibold text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={depositBusy || Boolean(amountError) || Boolean(depositBalanceError) || principalLedgerBalanceLoading}
                  type="button"
                  onClick={() => void deposit()}
                >
                  {depositBusy ? "Depositing" : "Deposit"}
                </button>
              </div>
              <div className="grid gap-1 text-xs text-muted">
                <p>II principal balance: {principalLedgerBalanceLabel}</p>
                <p>Total II principal debit: {totalDepositDebit ? formatTokenAmountFromE8s(totalDepositDebit.toString()) : "-"}</p>
                {principalLedgerBalanceError ? <p className="text-red-700">{principalLedgerBalanceError}</p> : null}
              </div>
              {amountError && amount.trim() ? <p className="text-xs text-red-700">{amountError}</p> : null}
              {depositBalanceError ? <p className="text-xs text-red-700">{depositBalanceError}</p> : null}
              {depositState === "success" && depositMessage ? <AdminNotice tone="success" message={depositMessage} /> : null}
              {depositState === "error" && depositMessage ? <AdminNotice tone="error" message={depositMessage} /> : null}
            </AdminPanel>

            <AdminPanel className="grid gap-3 bg-white" padding="md">
              <h2 className="text-lg font-semibold">Withdraw KINIC</h2>
              <div className="grid gap-3">
                <div className="relative min-w-0">
                  <input
                    className="min-h-11 w-full min-w-0 rounded-lg border border-line px-3 py-2 pr-20 font-mono text-sm outline-none focus:border-accent"
                    inputMode="decimal"
                    placeholder="Amount"
                    value={withdrawAmount}
                    onChange={updateWithdrawAmount}
                  />
                  <button
                    className="absolute right-2 top-1/2 min-h-8 -translate-y-1/2 rounded-md border border-line bg-paper px-3 text-xs font-semibold text-ink hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={withdrawBusy || maxWithdrawAmountE8s <= 0n}
                    type="button"
                    onClick={useMaxWithdrawAmount}
                  >
                    Max
                  </button>
                </div>
                <input
                  className="min-h-11 min-w-0 rounded-lg border border-line px-3 py-2 font-mono text-sm outline-none focus:border-accent"
                  placeholder="Recipient principal"
                  value={withdrawRecipient}
                  onChange={updateWithdrawRecipient}
                />
              </div>
              <div className="grid gap-1 text-xs text-muted">
                <p>Balance: {currentBalance}</p>
                <p>Total App balance debit: {totalWithdrawDebit ? formatTokenAmountFromE8s(totalWithdrawDebit.toString()) : "-"}</p>
              </div>
              <button
                className="min-h-11 w-fit rounded-lg border border-action bg-action px-4 text-sm font-semibold text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                disabled={withdrawBusy}
                type="button"
                onClick={() => void withdraw()}
              >
                {withdrawBusy ? "Withdrawing" : "Withdraw"}
              </button>
              {withdrawAmountError && withdrawAmount.trim() ? <p className="text-xs text-red-700">{withdrawAmountError}</p> : null}
              {withdrawRecipientError && withdrawRecipient.trim() ? <p className="text-xs text-red-700">{withdrawRecipientError}</p> : null}
              {withdrawState === "success" && withdrawMessage ? <AdminNotice tone="success" message={withdrawMessage} /> : null}
              {withdrawState === "error" && withdrawMessage ? <AdminNotice tone="error" message={withdrawMessage} /> : null}
            </AdminPanel>
          </section>
        ) : (
          <AdminPanel className="grid gap-4 bg-white" padding="md">
            <div className="grid gap-1">
              <h1 className="text-xl font-semibold text-ink">My Profile</h1>
              <p className="text-sm leading-6 text-muted">Login with Internet Identity to view your principal and manage App KINIC.</p>
            </div>
            <button
              className="min-h-11 w-fit rounded-lg border border-action bg-action px-4 text-sm font-semibold text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!authReady || authLoading}
              type="button"
              onClick={() => void login()}
            >
              Internet Identity
            </button>
          </AdminPanel>
        )}
      </div>
    </AdminContent>
  );
}

function parsePrincipalText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return Principal.fromText(trimmed).toText();
  } catch {
    return null;
  }
}

function parseE8sText(value: string | null): bigint | null {
  if (!value || !/^[0-9]+$/.test(value)) return null;
  return BigInt(value);
}

function formatKinicInputFromE8s(value: bigint): string {
  if (value <= 0n) return "0";
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}
