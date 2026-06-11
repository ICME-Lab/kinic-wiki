"use client";

// Where: /profile client UI.
// What: shows the signed-in principal and direct ledger balance.
// Why: payments now settle by direct ICRC-2 transfers, so no canister-held app balance is exposed.
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { AdminContent } from "@/components/admin-shell";
import { AdminField, AdminIconButton, AdminNotice, AdminPanel } from "@/components/admin-ui";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { getPrincipalKinicLedgerBalance } from "@/lib/kinic-wallet";

type ProfileClientProps = {
  canisterId: string;
};

export function ProfileClient({ canisterId }: ProfileClientProps) {
  const { authLoading, authReady, login, principal } = useAppSession();
  const [ledgerBalance, setLedgerBalance] = useState<string | null>(null);
  const [ledgerBalanceError, setLedgerBalanceError] = useState<string | null>(null);
  const [ledgerBalanceLoading, setLedgerBalanceLoading] = useState(false);

  const loadProfile = useCallback(async () => {
    if (!principal) {
      setLedgerBalance(null);
      setLedgerBalanceError(null);
      setLedgerBalanceLoading(false);
      return;
    }
    setLedgerBalanceLoading(true);
    setLedgerBalanceError(null);
    try {
      setLedgerBalance(await getPrincipalKinicLedgerBalance(canisterId, principal));
    } catch (cause) {
      setLedgerBalance(null);
      setLedgerBalanceError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLedgerBalanceLoading(false);
    }
  }, [canisterId, principal]);

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

  const balanceLabel = ledgerBalanceLoading ? "Loading" : ledgerBalance !== null ? formatTokenAmountFromE8s(ledgerBalance) : "-";

  return (
    <AdminContent>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 text-ink">
        <AdminPanel className="grid gap-4 bg-white" padding="md">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-ink">My Profile</h1>
            </div>
            <AdminIconButton label="Refresh profile" title="Refresh" onClick={() => void loadProfile()}>
              <RefreshCw aria-hidden size={16} />
            </AdminIconButton>
          </div>

          {!principal ? (
            <div className="grid gap-3">
              <AdminNotice tone="info" message="Login with Internet Identity to view your principal." />
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-action bg-action px-4 text-sm font-semibold text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!authReady || authLoading}
                type="button"
                onClick={() => void login()}
              >
                Internet Identity
              </button>
            </div>
          ) : (
            <div className="grid gap-3">
              <AdminField breakAll mono label="Principal" value={principal} />
              <AdminField mono label="Ledger KINIC balance" value={balanceLabel} />
              {ledgerBalanceError ? <AdminNotice tone="error" message={ledgerBalanceError} /> : null}
            </div>
          )}
        </AdminPanel>
      </div>
    </AdminContent>
  );
}
