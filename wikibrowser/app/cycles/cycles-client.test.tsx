// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CyclesClient } from "@/app/cycles/cycles-client";

const mocks = vi.hoisted(() => ({
  identity: { getPrincipal: () => ({ toText: () => "ii-principal" }) },
  listDatabases: vi.fn(),
  purchase: vi.fn(),
  refreshIdentity: vi.fn(),
  refreshWallet: vi.fn(),
  replace: vi.fn(),
  session: {} as Record<string, unknown>
}));

vi.mock("@/lib/app-router", () => ({ useAppNavigate: () => ({ replace: mocks.replace }) }));
vi.mock("@/app/app-session-provider", () => ({
  connectedWalletPrincipal: (wallet: { connection: { principal: string } }) => wallet.connection.principal,
  useAppSession: () => mocks.session
}));
vi.mock("@/lib/cycles-state", () => ({
  databaseCyclesHref: () => "/cycles",
  databaseCyclesView: () => ({ purchaseAvailable: true, summary: "fundable" })
}));
vi.mock("@/lib/vfs-client", () => ({
  getCyclesBillingConfig: vi.fn().mockResolvedValue({ cyclesPerKinic: "234500000000" }),
  listDatabasesAuthenticated: mocks.listDatabases
}));
vi.mock("@/lib/kinic-wallet", () => ({ purchaseCyclesWithFundingSource: mocks.purchase }));

beforeEach(() => {
  vi.stubEnv("VITE_KINIC_WIKI_CANISTER_ID", "aaaaa-aa");
  mocks.listDatabases.mockReset().mockResolvedValue([{ databaseId: "db-1", status: "active", metadata: { name: "Database" } }]);
  mocks.purchase.mockReset().mockResolvedValue({
    provider: "ii",
    approveBlockIndex: "1",
    approvedAllowanceE8s: "100100000",
    purchasedCycles: "234,500,000,000",
    paymentAmountE8s: "100000000",
    transferFeeE8s: "100000",
    balanceCycles: "234,500,000,000"
  });
  mocks.refreshIdentity.mockReset();
  mocks.refreshWallet.mockReset();
  mocks.replace.mockReset();
  mocks.session = {
    authClient: { getIdentity: () => mocks.identity },
    authError: null,
    authLoading: false,
    authReady: true,
    identityLedgerBalance: "100200000",
    identityLedgerBalanceError: null,
    identityLedgerBalanceLoading: false,
    login: vi.fn(),
    principal: "ii-principal",
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

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Cycles funding source", () => {
  it("allows the exact amount plus two fees from Internet Identity", async () => {
    render(<CyclesClient canisterId="aaaaa-aa" databaseId="db-1" databaseStatus="active" />);
    const button = await screen.findByRole("button", { name: "Purchase cycles with Internet Identity" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.getAllByText("1.002 KINIC")).toHaveLength(2);
    fireEvent.click(button);

    await waitFor(() => expect(mocks.purchase).toHaveBeenCalledWith(
      { canisterId: "aaaaa-aa", databaseId: "db-1", paymentAmountE8s: 100_000_000n },
      { provider: "ii", identity: mocks.identity }
    ));
    expect(mocks.refreshIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.refreshWallet).not.toHaveBeenCalled();
  });

  it("disables the purchase one base unit below the required balance", async () => {
    mocks.session.identityLedgerBalance = "100199999";
    render(<CyclesClient canisterId="aaaaa-aa" databaseId="db-1" databaseStatus="active" />);
    const button = await screen.findByRole("button", { name: "Purchase cycles with Internet Identity" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("This account needs at least 1.002 KINIC.")).toBeTruthy();
  });

  it("prefers a connected wallet and refreshes only that source after success", async () => {
    const wallet = { provider: "plug", connection: { principal: "wallet-principal" } };
    mocks.session.wallet = wallet;
    mocks.session.walletBalance = "100200000";
    mocks.purchase.mockResolvedValue({
      provider: "plug",
      approvedAllowanceE8s: "100100000",
      purchasedCycles: "234,500,000,000",
      paymentAmountE8s: "100000000",
      transferFeeE8s: "100000",
      balanceCycles: "234,500,000,000"
    });
    render(<CyclesClient canisterId="aaaaa-aa" databaseId="db-1" databaseStatus="active" />);
    const button = await screen.findByRole("button", { name: "Purchase cycles with Plug" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(mocks.purchase).toHaveBeenCalledWith(expect.anything(), wallet));
    expect(mocks.refreshWallet).toHaveBeenCalledWith(wallet);
    expect(mocks.refreshIdentity).not.toHaveBeenCalled();
  });

  it("does not apply a completed purchase to a different signed-in principal", async () => {
    const purchaseResult = deferred<Record<string, string>>();
    mocks.purchase.mockReturnValue(purchaseResult.promise);
    const rendered = render(<CyclesClient canisterId="aaaaa-aa" databaseId="db-1" databaseStatus="active" />);
    const button = await screen.findByRole("button", { name: "Purchase cycles with Internet Identity" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.purchase).toHaveBeenCalledTimes(1));

    mocks.session.principal = "different-principal";
    rendered.rerender(<CyclesClient canisterId="aaaaa-aa" databaseId="db-1" databaseStatus="active" />);
    purchaseResult.resolve({
      provider: "ii",
      approvedAllowanceE8s: "100100000",
      purchasedCycles: "234,500,000,000",
      paymentAmountE8s: "100000000",
      transferFeeE8s: "100000",
      balanceCycles: "234,500,000,000"
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Purchase cycles with Internet Identity" })).toBeTruthy());
    expect(mocks.refreshIdentity).not.toHaveBeenCalled();
    expect(mocks.refreshWallet).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("does not apply a purchase after the principal changes during balance refresh", async () => {
    const refreshResult = deferred<void>();
    mocks.refreshIdentity.mockReturnValue(refreshResult.promise);
    const rendered = render(<CyclesClient canisterId="aaaaa-aa" databaseId="db-1" databaseStatus="active" />);
    const button = await screen.findByRole("button", { name: "Purchase cycles with Internet Identity" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.refreshIdentity).toHaveBeenCalledTimes(1));

    mocks.session.principal = "different-principal";
    rendered.rerender(<CyclesClient canisterId="aaaaa-aa" databaseId="db-1" databaseStatus="active" />);
    refreshResult.resolve();

    await waitFor(() => expect(screen.getByRole("button", { name: "Purchase cycles with Internet Identity" })).toBeTruthy());
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/purchased cycles/)).toBeNull();
  });

  it("does not show a purchase failure for a different signed-in principal", async () => {
    const purchaseResult = deferred<Record<string, string>>();
    mocks.purchase.mockReturnValue(purchaseResult.promise);
    const rendered = render(<CyclesClient canisterId="aaaaa-aa" databaseId="db-1" databaseStatus="active" />);
    const button = await screen.findByRole("button", { name: "Purchase cycles with Internet Identity" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.purchase).toHaveBeenCalledTimes(1));

    mocks.session.principal = "different-principal";
    rendered.rerender(<CyclesClient canisterId="aaaaa-aa" databaseId="db-1" databaseStatus="active" />);
    purchaseResult.reject(new Error("old session failed"));

    await waitFor(() => expect(screen.getByRole("button", { name: "Purchase cycles with Internet Identity" })).toBeTruthy());
    expect(screen.queryByText(/did not complete/)).toBeNull();
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
