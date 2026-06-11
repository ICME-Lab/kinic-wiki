"use client";

// Where: /profile client UI.
// What: shows the signed-in principal and marketplace account summary.
// Why: profile should reflect canister marketplace access and seller activity, not token custody.
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppSession } from "@/app/app-session-provider";
import { AdminContent } from "@/components/admin-shell";
import { AdminField, AdminIconButton, AdminNotice, AdminPanel } from "@/components/admin-ui";
import { marketListEntitlements, marketListListings } from "@/lib/vfs-client";
import { errorMessage } from "@/lib/wiki-helpers";

type ProfileClientProps = {
  canisterId: string;
};

export function ProfileClient({ canisterId }: ProfileClientProps) {
  const { authClient, authLoading, authReady, login, principal } = useAppSession();
  const [profileStats, setProfileStats] = useState<ProfileStats | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  const loadProfile = useCallback(async () => {
    if (!authClient || !principal) {
      setProfileStats(null);
      setProfileError(null);
      setProfileLoading(false);
      return;
    }
    setProfileLoading(true);
    setProfileError(null);
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
    const page = await marketListListings(canisterId, cursor, PROFILE_PAGE_LIMIT);
    for (const listing of page.listings) {
      if (listing.sellerPrincipal !== principal) continue;
      sellerListings += 1;
      totalSales += parseNonNegativeBigInt(listing.purchaseCount);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { sellerListings, totalSales: totalSales.toString() };
}

function parseNonNegativeBigInt(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function ProfileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-paper p-3">
      <p className="text-xs font-semibold uppercase text-muted">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold text-ink">{value}</p>
    </div>
  );
}
