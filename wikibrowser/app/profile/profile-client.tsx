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
import { depositKinicBalanceWithIdentity } from "@/lib/kinic-wallet";
import { kinicGetBalance, kinicWithdrawBalance } from "@/lib/vfs-client";

type ProfileClientProps = {
  canisterId: string;
};

type DepositState = "idle" | "running" | "success" | "error";
type WithdrawState = "idle" | "running" | "success" | "error";

export function ProfileClient({ canisterId }: ProfileClientProps) {
  const { authClient, kinicBalance, kinicBalanceError, kinicBalanceLoading, login, principal, refreshKinicBalance } = useAppSession();
  const [amount, setAmount] = useState("1");
  const [depositState, setDepositState] = useState<DepositState>("idle");
  const [depositMessage, setDepositMessage] = useState<string | null>(null);
  const [withdrawAmount, setWithdrawAmount] = useState("1");
  const [withdrawRecipient, setWithdrawRecipient] = useState("");
  const [withdrawSubaccount, setWithdrawSubaccount] = useState("");
  const [withdrawState, setWithdrawState] = useState<WithdrawState>("idle");
  const [withdrawMessage, setWithdrawMessage] = useState<string | null>(null);
  const [profileBalance, setProfileBalance] = useState<string | null>(null);
  const [profileBalanceError, setProfileBalanceError] = useState<string | null>(null);
  const parsedAmount = useMemo(() => parseKinicAmount(amount), [amount]);
  const parsedWithdrawAmount = useMemo(() => parseKinicAmount(withdrawAmount), [withdrawAmount]);
  const parsedWithdrawRecipient = useMemo(() => parsePrincipalText(withdrawRecipient), [withdrawRecipient]);
  const parsedWithdrawSubaccount = useMemo(() => parseSubaccountHex(withdrawSubaccount), [withdrawSubaccount]);
  const amountError = parsedAmount ? null : "Enter an amount greater than 0 KINIC";
  const withdrawAmountError = parsedWithdrawAmount ? null : "Enter an amount greater than 0 KINIC";
  const withdrawRecipientError = withdrawRecipient.trim() ? (parsedWithdrawRecipient ? null : "Enter a valid recipient principal") : "Enter a recipient principal";
  const withdrawSubaccountError = withdrawSubaccount.trim() && !parsedWithdrawSubaccount ? "Enter 64 hex characters for a 32-byte subaccount" : null;
  const balance = profileBalance ?? kinicBalance;
  const balanceError = profileBalanceError ?? kinicBalanceError;
  const currentBalance = kinicBalanceLoading ? "Loading" : balance !== null ? formatTokenAmountFromE8s(balance) : "-";
  const totalWithdrawDebit = parsedWithdrawAmount ? BigInt(parsedWithdrawAmount) + KINIC_LEDGER_FEE_E8S : null;
  const depositBusy = depositState === "running";
  const withdrawBusy = withdrawState === "running";

  const loadProfile = useCallback(async () => {
    if (!authClient || !principal) {
      setProfileBalance(null);
      setProfileBalanceError(null);
      return;
    }
    setProfileBalanceError(null);
    try {
      const identity = authClient.getIdentity();
      const balanceResult = await kinicGetBalance(canisterId, identity);
      setProfileBalance(balanceResult.balanceE8s);
    } catch (cause) {
      setProfileBalance(null);
      setProfileBalanceError(cause instanceof Error ? cause.message : String(cause));
    }
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

  function updateWithdrawSubaccount(event: ChangeEvent<HTMLInputElement>) {
    setWithdrawSubaccount(event.target.value);
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
    if (withdrawSubaccountError) {
      setWithdrawState("error");
      setWithdrawMessage(withdrawSubaccountError);
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
        parsedWithdrawRecipient,
        parsedWithdrawSubaccount
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
              <AdminField label="Internet Identity" value="Connected" />
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
              <AdminNotice tone="warning" message="Use Deposit and Withdraw for App balance movements. Direct ledger transfers are not credited to App balance." />
              <div className="flex flex-wrap gap-2">
                <input
                  className="min-h-11 min-w-0 flex-1 rounded-lg border border-line px-3 py-2 font-mono text-sm outline-none focus:border-accent"
                  inputMode="decimal"
                  value={amount}
                  onChange={updateAmount}
                />
                <button
                  className="min-h-11 rounded-lg border border-action bg-action px-4 text-sm font-semibold text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={depositBusy}
                  type="button"
                  onClick={() => void deposit()}
                >
                  {depositBusy ? "Depositing" : "Deposit"}
                </button>
              </div>
              {amountError && amount.trim() ? <p className="text-xs text-red-700">{amountError}</p> : null}
              {depositState === "success" && depositMessage ? <AdminNotice tone="success" message={depositMessage} /> : null}
              {depositState === "error" && depositMessage ? <AdminNotice tone="error" message={depositMessage} /> : null}
            </AdminPanel>

            <AdminPanel className="grid gap-3 bg-white" padding="md">
              <h2 className="text-lg font-semibold">Withdraw KINIC</h2>
              <AdminNotice tone="info" message="Recipient receives amount. App balance decreases by amount plus ledger fee." />
              <div className="grid gap-3">
                <input
                  className="min-h-11 min-w-0 rounded-lg border border-line px-3 py-2 font-mono text-sm outline-none focus:border-accent"
                  inputMode="decimal"
                  placeholder="Amount"
                  value={withdrawAmount}
                  onChange={updateWithdrawAmount}
                />
                <input
                  className="min-h-11 min-w-0 rounded-lg border border-line px-3 py-2 font-mono text-sm outline-none focus:border-accent"
                  placeholder="Recipient principal"
                  value={withdrawRecipient}
                  onChange={updateWithdrawRecipient}
                />
                <input
                  className="min-h-11 min-w-0 rounded-lg border border-line px-3 py-2 font-mono text-sm outline-none focus:border-accent"
                  placeholder="Subaccount hex, optional"
                  value={withdrawSubaccount}
                  onChange={updateWithdrawSubaccount}
                />
              </div>
              <div className="grid gap-1 text-xs text-muted">
                <p>Ledger fee: {formatTokenAmountFromE8s(KINIC_LEDGER_FEE_E8S.toString())}</p>
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
              {withdrawSubaccountError ? <p className="text-xs text-red-700">{withdrawSubaccountError}</p> : null}
              {withdrawState === "success" && withdrawMessage ? <AdminNotice tone="success" message={withdrawMessage} /> : null}
              {withdrawState === "error" && withdrawMessage ? <AdminNotice tone="error" message={withdrawMessage} /> : null}
            </AdminPanel>
          </section>
        ) : null}
      </div>
    </AdminContent>
  );
}

function parseSubaccountHex(value: string): number[] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return null;
  const bytes: number[] = [];
  for (let index = 0; index < trimmed.length; index += 2) {
    bytes.push(Number.parseInt(trimmed.slice(index, index + 2), 16));
  }
  return bytes;
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
