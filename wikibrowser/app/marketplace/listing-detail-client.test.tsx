// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListingDetailClient } from "@/app/marketplace/[listingId]/listing-detail-client";

const mocks = vi.hoisted(() => ({
  identity: { getPrincipal: () => ({ toText: () => "ii-principal" }) },
  loadListing: vi.fn(),
  preview: vi.fn(),
  purchase: vi.fn(),
  refreshIdentity: vi.fn(),
  refreshIdentityFor: vi.fn(),
  refreshWallet: vi.fn(),
  session: {} as Record<string, unknown>,
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn()
}));

vi.mock("@/components/app-link", () => ({
  AppLink: ({ children, href, ...props }: { children: ReactNode; href: string }) => <a href={href} {...props}>{children}</a>
}));
vi.mock("@/components/ui/toast", () => ({
  toast: { error: mocks.toastError, info: mocks.toastInfo, success: mocks.toastSuccess }
}));
vi.mock("@/app/app-session-provider", () => ({
  connectedWalletPrincipal: (wallet: { connection: { principal: string } }) => wallet.connection.principal,
  useAppSession: () => mocks.session
}));
vi.mock("@/lib/vfs-client", () => ({
  marketGetListing: mocks.loadListing,
  marketPreviewPurchase: mocks.preview
}));
vi.mock("@/lib/kinic-wallet", () => ({ purchaseMarketAccessWithFundingSource: mocks.purchase }));

const listingDetail = {
  listing: {
    listing: {
      listingId: "listing-1",
      sellerPrincipal: "seller-principal",
      payoutPrincipal: "payout-principal",
      databaseId: "db-1",
      priceE8s: "50000000",
      status: "Active",
      revision: "1",
      purchaseCount: "0",
      reportCount: "0",
      createdAtMs: "1",
      updatedAtMs: "1"
    },
    databaseMetadata: { name: "Market database", description: "Description", llmSummary: null, tagsJson: "[]" }
  },
  verifiedStats: {
    totalNodes: "1",
    wikiNodes: "1",
    sourceNodes: "0",
    folderNodes: "0",
    markdownChars: "10",
    sourceChars: "0",
    linkEdges: "0",
    logicalSizeBytes: "10",
    lastContentUpdatedAtMs: null
  },
  preview: { topLevelPaths: [], excerpts: [], categoryGraph: { nodes: [], edges: [] }, graphLinks: [], previewStale: false }
};

beforeEach(() => {
  mocks.loadListing.mockReset().mockResolvedValue(listingDetail);
  mocks.preview.mockReset().mockResolvedValue({ listingId: "listing-1", databaseId: "db-1", priceE8s: "50000000", alreadyEntitled: false });
  mocks.purchase.mockReset().mockResolvedValue({ ledgerBlockIndex: "99" });
  mocks.refreshIdentity.mockReset();
  mocks.refreshIdentityFor.mockReset();
  mocks.refreshWallet.mockReset();
  mocks.toastError.mockReset();
  mocks.toastInfo.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.session = {
    authClient: { getIdentity: () => mocks.identity },
    identityLedgerBalance: "50200000",
    identityLedgerBalanceError: null,
    identityLedgerBalanceLoading: false,
    principal: "ii-principal",
    refreshIdentityLedgerBalanceFor: mocks.refreshIdentityFor,
    refreshIdentityLedgerBalance: mocks.refreshIdentity,
    refreshWalletBalance: mocks.refreshWallet,
    setWalletControlsLocked: vi.fn(),
    wallet: null,
    walletBalance: null,
    walletBalanceError: null,
    walletBalanceLoading: false,
    walletBusyProvider: null,
    walletSessionReady: true
  };
});

afterEach(cleanup);

describe("Marketplace funding source", () => {
  it("rechecks the price before approving an exact-boundary II purchase", async () => {
    render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const button = await screen.findByRole("button", { name: "Purchase with Internet Identity" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.getAllByText("0.502 KINIC")).toHaveLength(2);
    fireEvent.click(button);

    await waitFor(() => expect(mocks.purchase).toHaveBeenCalledWith(
      { canisterId: "aaaaa-aa", listingId: "listing-1", priceE8s: 50_000_000n, accessPrincipal: "ii-principal" },
      { provider: "ii", identity: mocks.identity }
    ));
    expect(mocks.preview.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.purchase.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.refreshIdentityFor).toHaveBeenCalledWith(mocks.identity, "ii-principal");
    expect(mocks.refreshWallet).not.toHaveBeenCalled();
  });

  it("blocks a balance one base unit below price plus two fees", async () => {
    mocks.session.identityLedgerBalance = "50199999";
    render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const button = await screen.findByRole("button", { name: "Purchase with Internet Identity" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("This account needs at least 0.502 KINIC.")).toBeTruthy();
    fireEvent.click(button);
    expect(mocks.purchase).not.toHaveBeenCalled();
  });

  it("does not start payment when the principal changes after preview", async () => {
    const previewResult = deferred<{ listingId: string; databaseId: string; priceE8s: string; alreadyEntitled: boolean }>();
    const rendered = render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    mocks.preview.mockReturnValueOnce(previewResult.promise);
    const button = await screen.findByRole("button", { name: "Purchase with Internet Identity" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(2));

    mocks.session.principal = "different-principal";
    rendered.rerender(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    previewResult.resolve({ listingId: "listing-1", databaseId: "db-1", priceE8s: "50000000", alreadyEntitled: false });

    await waitFor(() => expect(mocks.purchase).not.toHaveBeenCalled());
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("refreshes the submitted balance when marketplace payment fails", async () => {
    mocks.purchase.mockRejectedValue(new Error("ambiguous transfer"));
    render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const button = await screen.findByRole("button", { name: "Purchase with Internet Identity" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(mocks.refreshIdentityFor).toHaveBeenCalledWith(mocks.identity, "ii-principal"));
    expect(mocks.toastError).toHaveBeenCalledWith("ambiguous transfer");
  });

  it("does not apply a purchase after the principal changes during balance refresh", async () => {
    const refreshResult = deferred<void>();
    mocks.refreshIdentityFor.mockReturnValue(refreshResult.promise);
    const rendered = render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const button = await screen.findByRole("button", { name: "Purchase with Internet Identity" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.refreshIdentityFor).toHaveBeenCalledTimes(1));

    mocks.session.principal = "different-principal";
    rendered.rerender(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    refreshResult.resolve();

    await waitFor(() => expect(screen.getByRole("button", { name: "Purchase with Internet Identity" })).toBeTruthy());
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Purchased" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open database" })).toBeNull();
  });

  it("does not show a purchase failure for a different signed-in principal", async () => {
    const purchaseResult = deferred<{ ledgerBlockIndex: string }>();
    mocks.purchase.mockReturnValue(purchaseResult.promise);
    const rendered = render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const button = await screen.findByRole("button", { name: "Purchase with Internet Identity" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.purchase).toHaveBeenCalledTimes(1));

    mocks.session.principal = "different-principal";
    rendered.rerender(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    purchaseResult.reject(new Error("old session failed"));

    await waitFor(() => expect(screen.getByRole("button", { name: "Purchase with Internet Identity" })).toBeTruthy());
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
