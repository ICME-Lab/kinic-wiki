"use client";

// Where: /profile client UI.
// What: shows the signed-in principal and marketplace account summary.
// Why: profile should reflect canister marketplace access and seller activity, not token custody.
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Principal } from "@icp-sdk/core/principal";
import { useAppSession } from "@/app/app-session-provider";
import { AdminContent } from "@/components/admin-shell";
import { AdminField, AdminIconButton, AdminNotice, AdminPanel } from "@/components/admin-ui";
import { KINIC_LEDGER_FEE_E8S, kinicBaseUnitsPerToken } from "@/lib/cycles";
import { parseKinicAmountE8sInput } from "@/lib/cycles-url";
import { formatTokenAmountFromE8s } from "@/lib/kinic-amount";
import { getPrincipalKinicLedgerBalance, transferKinicFromIdentity } from "@/lib/kinic-wallet";
import { marketListEntitlements, marketListSellerListings } from "@/lib/vfs-client";
import { errorMessage } from "@/lib/wiki-helpers";

type ProfileClientProps = {
  canisterId: string;
};

export function ProfileClient({ canisterId }: ProfileClientProps) {
  const { authClient, authLoading, authReady, login, principal } = useAppSession();
  const [profileStats, setProfileStats] = useState<ProfileStats | null>(null);
  const [ledgerBalance, setLedgerBalance] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [recipientPrincipal, setRecipientPrincipal] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferStatus, setTransferStatus] = useState<TransferStatus>("idle");
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const amountTouched = transferAmount.trim().length > 0;
  const parsedTransferAmount = useMemo(() => parseKinicAmountE8sInput(transferAmount), [transferAmount]);
  const recipientError = recipientPrincipal.trim() && !isValidPrincipal(recipientPrincipal) ? "Recipient principal is invalid" : null;
  const amountError = amountTouched && typeof parsedTransferAmount === "string" ? parsedTransferAmount : null;
  const maxTransferAmount = useMemo(() => transferableBalanceE8s(ledgerBalance), [ledgerBalance]);
  const transferDisabled =
    transferStatus === "running" ||
    !authClient ||
    !principal ||
    !recipientPrincipal.trim() ||
    Boolean(recipientError) ||
    typeof parsedTransferAmount !== "bigint";

  const loadProfile = useCallback(async () => {
    if (!authClient || !principal) {
      setProfileStats(null);
      setLedgerBalance(null);
      setProfileError(null);
      setLedgerError(null);
      setProfileLoading(false);
      setLedgerLoading(false);
      return;
    }
    setProfileLoading(true);
    setLedgerLoading(true);
    setProfileError(null);
    setLedgerError(null);
    try {
      const identity = authClient.getIdentity();
      const [purchasedDatabases, sales] = await Promise.all([
        loadPurchasedDatabaseCount(canisterId, identity),
        loadSellerStats(canisterId, principal)
      ]);
      setProfileStats({
        purchasedDatabases,
        sellerListings: sales.sellerListings,
        totalSales: sales.totalSales
      });
    } catch (cause) {
      setProfileStats(null);
      setProfileError(errorMessage(cause));
    } finally {
      setProfileLoading(false);
    }
    try {
      setLedgerBalance(await getPrincipalKinicLedgerBalance(canisterId, principal));
    } catch (cause) {
      setLedgerBalance(null);
      setLedgerError(errorMessage(cause));
    } finally {
      setLedgerLoading(false);
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

  async function sendKinic() {
    if (!authClient || !principal || typeof parsedTransferAmount !== "bigint" || recipientError) return;
    setTransferStatus("running");
    setTransferMessage(null);
    try {
      const blockIndex = await transferKinicFromIdentity({
        canisterId,
        identity: authClient.getIdentity(),
        toPrincipal: recipientPrincipal.trim(),
        amountE8s: parsedTransferAmount
      });
      setTransferMessage(`Transfer complete. Ledger block ${blockIndex}.`);
      setTransferStatus("success");
    } catch (cause) {
      setTransferMessage(errorMessage(cause));
      setTransferStatus("error");
      return;
    }
    try {
      setLedgerError(null);
      setLedgerBalance(await getPrincipalKinicLedgerBalance(canisterId, principal));
    } catch (cause) {
      setLedgerBalance(null);
      setLedgerError(errorMessage(cause));
    }
  }

  function useMaxTransferAmount() {
    if (maxTransferAmount <= 0n) return;
    setTransferAmount(formatKinicInputFromE8s(maxTransferAmount));
  }

  const balanceLabel = ledgerLoading ? "Loading" : ledgerBalance !== null ? formatTokenAmountFromE8s(ledgerBalance) : "-";

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
            <div className="grid gap-4">
              <section className="grid gap-3">
                <AdminField breakAll mono label="Principal" value={principal} />
                <AdminField mono label="Ledger KINIC balance" value={balanceLabel} />
              </section>

              {ledgerError ? <AdminNotice tone="error" message={`Ledger balance unavailable: ${ledgerError}`} /> : null}

              <section className="grid gap-3">
                <h2 className="text-sm font-semibold uppercase text-muted">Send KINIC</h2>
                <label className="grid gap-1 text-sm">
                  <span className="text-xs uppercase text-muted">Recipient principal</span>
                  <input
                    className="min-h-11 rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs outline-none focus:border-accent"
                    value={recipientPrincipal}
                    onChange={(event) => setRecipientPrincipal(event.target.value)}
                  />
                  {recipientError ? <span className="text-xs text-red-700">{recipientError}</span> : null}
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="text-xs uppercase text-muted">KINIC amount</span>
                  <div className="flex gap-2">
                    <input
                      className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 font-mono text-sm outline-none focus:border-accent"
                      inputMode="decimal"
                      value={transferAmount}
                      onChange={(event) => setTransferAmount(event.target.value)}
                    />
                    <button
                      className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-line bg-paper px-3 text-sm font-semibold text-ink hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={ledgerLoading || maxTransferAmount <= 0n || transferStatus === "running"}
                      type="button"
                      onClick={useMaxTransferAmount}
                    >
                      Max
                    </button>
                  </div>
                  {amountError ? <span className="text-xs text-red-700">{amountError}</span> : null}
                </label>
                <button
                  className="inline-flex min-h-11 items-center justify-center rounded-lg border border-action bg-action px-4 text-sm font-semibold text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={transferDisabled}
                  type="button"
                  onClick={() => void sendKinic()}
                >
                  {transferStatus === "running" ? "Sending..." : "Send KINIC"}
                </button>
                {transferMessage ? <AdminNotice tone={transferStatus === "success" ? "success" : "error"} message={transferMessage} /> : null}
              </section>

              <section className="grid gap-3">
                <h2 className="text-sm font-semibold uppercase text-muted">Marketplace access</h2>
                <ProfileStat label="Purchased databases" value={profileLoading ? "Loading" : profileStats ? profileStats.purchasedDatabases.toString() : "0"} />
              </section>

              <section className="grid gap-3">
                <h2 className="text-sm font-semibold uppercase text-muted">Sales</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <ProfileStat label="Seller listings" value={profileLoading ? "Loading" : profileStats ? profileStats.sellerListings.toString() : "0"} />
                  <ProfileStat label="Total sales" value={profileLoading ? "Loading" : profileStats ? profileStats.totalSales.toString() : "0"} />
                </div>
              </section>

              {profileError ? <AdminNotice tone="error" message={profileError} /> : null}
            </div>
          )}
        </AdminPanel>
      </div>
    </AdminContent>
  );
}

type ProfileStats = {
  purchasedDatabases: number;
  sellerListings: number;
  totalSales: string;
};

type SellerStats = {
  sellerListings: number;
  totalSales: string;
};

type TransferStatus = "idle" | "running" | "success" | "error";

type IdentityLike = Parameters<typeof marketListEntitlements>[1];

const PROFILE_PAGE_LIMIT = 100;

async function loadPurchasedDatabaseCount(canisterId: string, identity: IdentityLike): Promise<number> {
  let cursor: string | null = null;
  let count = 0;
  do {
    const page = await marketListEntitlements(canisterId, identity, cursor, PROFILE_PAGE_LIMIT);
    count += page.entitlements.length;
    cursor = page.nextCursor;
  } while (cursor);
  return count;
}

async function loadSellerStats(canisterId: string, principal: string): Promise<SellerStats> {
  let cursor: string | null = null;
  let sellerListings = 0;
  let totalSales = 0n;
  do {
    const page = await marketListSellerListings(canisterId, principal, cursor, PROFILE_PAGE_LIMIT);
    for (const view of page.listings) {
      sellerListings += 1;
      totalSales += parseNonNegativeBigInt(view.listing.purchaseCount);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { sellerListings, totalSales: totalSales.toString() };
}

function parseNonNegativeBigInt(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function transferableBalanceE8s(value: string | null): bigint {
  const balance = parseNonNegativeBigInt(value ?? "");
  return balance > KINIC_LEDGER_FEE_E8S ? balance - KINIC_LEDGER_FEE_E8S : 0n;
}

function formatKinicInputFromE8s(value: bigint): string {
  const units = kinicBaseUnitsPerToken();
  const whole = value / units;
  const fraction = (value % units).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

function isValidPrincipal(value: string): boolean {
  try {
    Principal.fromText(value.trim());
    return true;
  } catch {
    return false;
  }
}

function ProfileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-paper p-3">
      <p className="text-xs font-semibold uppercase text-muted">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold text-ink">{value}</p>
    </div>
  );
}
