// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    walletPaymentReady: true,
    walletSessionReady: true
  };
});

afterEach(cleanup);

describe("Marketplace funding source", () => {
  it.each(["plug", "oisy"] as const)("offers scope consent for an unscoped %s without purchasing on consent", async provider => {
    const connectWallet = vi.fn();
    Object.assign(mocks.session, { wallet: { provider, connection: { principal: "payer", owner: "payer" } }, walletPaymentReady: false,
      walletBalance: "50200000", connectWallet });
    const view = render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const label = provider === "oisy" ? "OISY" : "Plug";
    const consent = await screen.findByRole("button", { name: `Authorize ${label} for purchase` });
    expect(connectWallet).not.toHaveBeenCalled();
    fireEvent.click(consent);
    expect(connectWallet).toHaveBeenCalledWith(provider);
    expect(mocks.purchase).not.toHaveBeenCalled();
    // A cancelled permission request keeps the explicit authorization action.
    view.rerender(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    expect(screen.getByRole("button", { name: `Authorize ${label} for purchase` })).toBeTruthy();
    expect(mocks.purchase).not.toHaveBeenCalled();
    mocks.session.walletPaymentReady = true;
    view.rerender(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    fireEvent.click(screen.getByRole("button", { name: `Purchase with ${label}` }));
    await waitFor(() => expect(mocks.purchase).toHaveBeenCalledTimes(1));
  });

  it("rechecks the price before approving an exact-boundary II purchase", async () => {
    render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const button = await screen.findByRole("button", { name: "Purchase with Internet Identity" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.getAllByText("0.502 KINIC")).toHaveLength(2);
    fireEvent.click(button);

    await waitFor(() => expect(mocks.purchase).toHaveBeenCalledWith(
      { canisterId: "aaaaa-aa", listingId: "listing-1", priceE8s: 50_000_000n, accessPrincipal: "ii-principal", isCurrent:expect.any(Function) },
      { provider: "ii", identity: mocks.identity }
    ));
    expect(mocks.preview.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.purchase.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.refreshIdentityFor).toHaveBeenCalledWith(mocks.identity, "ii-principal");
    expect(mocks.refreshWallet).not.toHaveBeenCalled();
  });

  it("shows the refreshed price after switching payment sources on the same listing", async () => {
    Object.assign(mocks.session, {
      wallet: {provider:"plug", connection:{principal:"payer"}},
      walletBalance:"50200000",
    });
    render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const buy = await screen.findByRole("button", {name:"Purchase with Plug"}) as HTMLButtonElement;
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    const refresh = deferred<typeof listingDetail>();
    mocks.preview.mockResolvedValueOnce({alreadyEntitled:false, priceE8s:"45000000"});
    mocks.loadListing.mockReturnValueOnce(refresh.promise);
    fireEvent.click(buy);
    await screen.findByText("Loading listing");
    fireEvent.click(screen.getByRole("radio", {name:/Internet Identity/}));
    expect(screen.getByRole("button", {name:"Purchase with Internet Identity"})).toBeTruthy();
    await act(async () => refresh.resolve({
      ...listingDetail, listing: {
        ...listingDetail.listing, listing: {...listingDetail.listing.listing, priceE8s:"45000000"},
      },
    }));
    expect(screen.queryByText("Loading listing")).toBeNull();
    expect(screen.getByText("0.450 KINIC")).toBeTruthy();
    expect(mocks.loadListing).toHaveBeenCalledTimes(2);
    expect(mocks.purchase).not.toHaveBeenCalled();
  });

  it("drops a departing listing while its purchase preview is still waiting", async () => {
    const waiting = deferred<{listingId:string; databaseId:string; priceE8s:string; alreadyEntitled:boolean}>();
    const view = render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const button = await screen.findByRole("button", {name:"Purchase with Internet Identity"}) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    mocks.preview.mockReturnValueOnce(waiting.promise);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(2));
    view.unmount();
    await act(async () => waiting.resolve({listingId:"listing-1", databaseId:"db-1", priceE8s:"50000000", alreadyEntitled:false}));
    expect(mocks.purchase).not.toHaveBeenCalled();
  });

  it.each(["preview success", "preview failure", "purchase success", "purchase failure"])(
    "keeps listing B locked while a retired listing A finishes with %s",
    async outcome => {
      mocks.loadListing.mockImplementation(async (_canister, id) => ({
        ...listingDetail, listing: {
          listing: {...listingDetail.listing.listing, listingId:id},
          databaseMetadata: {...listingDetail.listing.databaseMetadata, name:id},
        },
      }));
      const preview = {priceE8s:"50000000", alreadyEntitled:false};
      const oldPreview = deferred<typeof preview>();
      const oldOrder = deferred<{ledgerBlockIndex:string}>();
      const nextPreview = deferred<typeof preview>();
      const view = render(<ListingDetailClient canisterId="aaaaa-aa" listingId="A" />);
      const buy = () => screen.getByRole("button", {name:"Purchase with Internet Identity"}) as HTMLButtonElement;
      await screen.findByRole("heading", {name:"A"});
      await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
      const awaitingPreview = outcome.startsWith("preview");
      if (awaitingPreview) mocks.preview.mockReturnValueOnce(oldPreview.promise);
      else mocks.purchase.mockReturnValueOnce(oldOrder.promise);
      fireEvent.click(buy());
      await waitFor(() => expect(awaitingPreview ? mocks.preview : mocks.purchase).toHaveBeenCalledTimes(awaitingPreview ? 2 : 1));
      view.rerender(<ListingDetailClient canisterId="aaaaa-aa" listingId="B" />);
      await screen.findByRole("heading", {name:"B"});
      await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(buy().disabled).toBe(false));
      mocks.preview.mockReturnValueOnce(nextPreview.promise);
      fireEvent.click(buy());
      expect(buy().disabled).toBe(true);
      expect(mocks.session.setWalletControlsLocked).toHaveBeenLastCalledWith(true);
      await act(async () => {
        if (outcome === "preview success") oldPreview.resolve(preview);
        if (outcome === "preview failure") oldPreview.reject(Error("retired preview"));
        if (outcome === "purchase success") oldOrder.resolve({ledgerBlockIndex:"42"});
        if (outcome === "purchase failure") oldOrder.reject(Error("retired purchase"));
      });
      expect(buy().disabled).toBe(true);
      expect(mocks.session.setWalletControlsLocked).toHaveBeenLastCalledWith(true);
      expect(mocks.toastError).not.toHaveBeenCalled();
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      fireEvent.click(buy());
      await act(async () => nextPreview.resolve(preview));
      await screen.findByRole("button", {name:"Purchased"});
      expect(mocks.purchase.mock.calls.filter(([request]) => request.listingId === "B")).toHaveLength(1);
      expect(mocks.purchase).toHaveBeenCalledTimes(awaitingPreview ? 1 : 2);
      expect(mocks.session.setWalletControlsLocked).toHaveBeenLastCalledWith(false);
    }
  );

  it("keeps a late initial entitlement preview from releasing an active purchase", async () => {
    const initial = deferred<{alreadyEntitled:boolean}>();
    const confirmation = deferred<{alreadyEntitled:boolean;priceE8s:string}>();
    mocks.preview.mockReturnValueOnce(initial.promise).mockReturnValueOnce(confirmation.promise);
    render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const buy = await screen.findByRole("button", {name:"Purchase with Internet Identity"}) as HTMLButtonElement;
    fireEvent.click(buy);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(2));
    await act(async () => initial.resolve({alreadyEntitled:false}));
    expect(buy.disabled).toBe(true);
    expect(mocks.session.setWalletControlsLocked).toHaveBeenLastCalledWith(true);
    await act(async () => confirmation.resolve({alreadyEntitled:false,priceE8s:"50000000"}));
    await screen.findByRole("button", {name:"Purchased"});
    expect(mocks.purchase).toHaveBeenCalledOnce();
  });

  it("retires the confirmation guard when the listing unmounts", async () => {
    const rendered = render(<ListingDetailClient canisterId="aaaaa-aa" listingId="listing-1" />);
    const button = await screen.findByRole("button", {name:"Purchase with Internet Identity"}) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.purchase).toHaveBeenCalledOnce());
    const {isCurrent} = mocks.purchase.mock.calls[0][0];
    expect(isCurrent()).toBe(true);
    rendered.unmount();
    expect(isCurrent()).toBe(false);
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
