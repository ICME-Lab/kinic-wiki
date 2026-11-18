// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Principal } from "@icp-sdk/core/principal";
import { Actor, type Identity } from "@icp-sdk/core/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSessionProvider, useAppSession } from "@/app/app-session-provider";

const mocks = vi.hoisted(() => {
  const identity = { getPrincipal: () => Principal.fromText("aaaaa-aa") };
  return {
    authClient: {
      getIdentity: () => identity,
      isAuthenticated: vi.fn(),
      login: vi.fn(),
      logout: vi.fn()
    },
    authCreate: vi.fn(),
    getConnectedWalletBalance: vi.fn(),
    getPrincipalBalance: vi.fn(),
    identity
  };
});

vi.mock("@/lib/vfs-client", () => ({
  getCyclesBillingConfig: vi.fn(async () => ({ kinicLedgerCanisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai" }))
}));
vi.mock("@icp-sdk/auth/client", () => ({ AuthClient: { create: mocks.authCreate } }));
vi.mock("@/lib/kinic-wallet", () => ({
  connectOisyWallet: vi.fn(),
  connectPlugWallet: vi.fn(),
  getConnectedWalletKinicBalance: mocks.getConnectedWalletBalance,
  getPrincipalKinicLedgerBalance: mocks.getPrincipalBalance
}));

let observed: ReturnType<typeof useAppSession>;
function SessionProbe() {
  const session = useAppSession();
  observed = session;
  return (
    <div>
      <span data-testid="principal">{session.principal ?? "none"}</span>
      <span data-testid="balance">{session.identityLedgerBalance ?? "none"}</span>
      <span data-testid="balance-error">{session.identityLedgerBalanceError ?? "none"}</span>
      <span data-testid="balance-loading">{String(session.identityLedgerBalanceLoading)}</span>
      <span data-testid="wallet-principal">{session.wallet ? session.wallet.provider === "oisy" ? session.wallet.connection.owner : session.wallet.connection.principal : "none"}</span>
      <span data-testid="wallet-balance">{session.walletBalance ?? "none"}</span>
      <span data-testid="wallet-session-ready">{String(session.walletSessionReady)}</span>
      <button type="button" onClick={() => void session.refreshIdentityLedgerBalance()}>Refresh II</button>
      <button type="button" onClick={() => void session.refreshIdentityLedgerBalanceFor(mocks.identity as Identity, "aaaaa-aa")}>Refresh captured II</button>
      <button type="button" onClick={() => void session.logout()}>Logout</button>
    </div>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  Object.defineProperty(window, "ic", { configurable: true, value: { plug: { isConnected: async () => true, agent: { getPrincipal: async () => Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai") } } } });
  vi.stubEnv("VITE_KINIC_WIKI_CANISTER_ID", "aaaaa-aa");
  mocks.authClient.isAuthenticated.mockReset().mockResolvedValue(true);
  mocks.authClient.login.mockReset();
  mocks.authClient.logout.mockReset().mockResolvedValue(undefined);
  mocks.authCreate.mockReset().mockResolvedValue(mocks.authClient);
  mocks.getConnectedWalletBalance.mockReset().mockResolvedValue("0");
  mocks.getPrincipalBalance.mockReset().mockResolvedValue("123000000");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("AppSessionProvider Internet Identity balance", () => {
  it("loads, refreshes, reports failure, and clears the shared balance on logout", async () => {
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);

    await waitFor(() => expect(screen.getByTestId("principal").textContent).toBe("aaaaa-aa"));
    await waitFor(() => expect(screen.getByTestId("balance").textContent).toBe("123000000"));
    expect(mocks.getPrincipalBalance).toHaveBeenCalledWith("aaaaa-aa", "aaaaa-aa");

    mocks.getPrincipalBalance.mockRejectedValueOnce(new Error("ledger offline"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh II" }));
    await waitFor(() => expect(screen.getByTestId("balance-error").textContent).toContain("ledger offline"));
    expect(screen.getByTestId("balance").textContent).toBe("none");

    mocks.getPrincipalBalance.mockResolvedValueOnce("456000000");
    fireEvent.click(screen.getByRole("button", { name: "Refresh II" }));
    await waitFor(() => expect(screen.getByTestId("balance").textContent).toBe("456000000"));
    expect(screen.getByTestId("balance-error").textContent).toBe("none");

    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    await waitFor(() => expect(screen.getByTestId("principal").textContent).toBe("none"));
    expect(screen.getByTestId("balance").textContent).toBe("none");
  });

  it("discards an older balance response after a newer refresh", async () => {
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);
    await waitFor(() => expect(screen.getByTestId("balance").textContent).toBe("123000000"));

    const older = deferred<string>();
    const newer = deferred<string>();
    mocks.getPrincipalBalance.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh II" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh II" }));
    newer.resolve("300000000");
    await waitFor(() => expect(screen.getByTestId("balance").textContent).toBe("300000000"));
    older.resolve("200000000");
    await waitFor(() => expect(screen.getByTestId("balance-loading").textContent).toBe("false"));
    expect(screen.getByTestId("balance").textContent).toBe("300000000");
  });

  it("discards a captured principal response after logout", async () => {
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);
    await waitFor(() => expect(screen.getByTestId("balance").textContent).toBe("123000000"));

    const captured = deferred<string>();
    mocks.getPrincipalBalance.mockReturnValueOnce(captured.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh captured II" }));
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    captured.resolve("999000000");

    await waitFor(() => expect(screen.getByTestId("principal").textContent).toBe("none"));
    expect(screen.getByTestId("balance").textContent).toBe("none");
  });
});

describe("AppSessionProvider wallet restoration", () => {
  it("marks wallet restoration ready when there is no stored wallet", async () => {
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);

    await waitFor(() => expect(screen.getByTestId("wallet-session-ready").textContent).toBe("true"));
    expect(screen.getByTestId("wallet-principal").textContent).toBe("none");
  });

  it("restores a valid stored wallet before marking restoration ready", async () => {
    sessionStorage.setItem("kinic-wiki.wallet-session", JSON.stringify({ provider: "plug", principal: "ryjl3-tyaaa-aaaaa-aaaba-cai" }));
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);

    await waitFor(() => expect(screen.getByTestId("wallet-session-ready").textContent).toBe("true"));
    expect(screen.getByTestId("wallet-principal").textContent).toBe("ryjl3-tyaaa-aaaaa-aaaba-cai");
    expect(observed.walletPaymentReady).toBe(false);
  });

  it("keeps OISY reload metadata without displaying a live wallet or reading a default balance", async () => {
    sessionStorage.setItem("kinic-wiki.wallet-session", JSON.stringify({ provider: "oisy", principal: "aaaaa-aa" }));
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);
    await waitFor(() => expect(screen.getByTestId("wallet-session-ready").textContent).toBe("true"));
    expect(screen.getByTestId("wallet-principal").textContent).toBe("none");
    expect(mocks.getConnectedWalletBalance).not.toHaveBeenCalled();
  });

  it("keeps a scoped Plug transport through route changes and a paid reply, until explicit disconnect", async () => {
    const owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
    const purchase = vi.fn(async () => ({ Ok: { block_index: 42n, amount_cycles: 3n, balance_cycles: 6n } }));
    const plug = { isConnected: vi.fn(async () => true), requestConnect: vi.fn(async () => true), disconnect: vi.fn(async () => {}),
      agent: { getPrincipal: async () => owner }, createActor: vi.fn(async () => ({ purchase_database_cycles: purchase })) };
    Object.defineProperty(window, "ic", { configurable: true, value: { plug } });
    const view = render(<AppSessionProvider><SessionProbe key="dashboard" /></AppSessionProvider>);
    await waitFor(() => expect(observed.principal).toBe("aaaaa-aa"));
    await act(async () => { await observed.connectWallet("plug"); });
    expect(observed.walletPaymentReady).toBe(true);
    const transport = observed.walletSnapshot.transport!;
    const guard = observed.walletSession.capture();
    view.rerender(<AppSessionProvider><SessionProbe key="cycles" /></AppSessionProvider>);
    expect(observed.walletSnapshot.transport).toBe(transport);
    const { callWikiWithPayer } = await import("@/lib/wallet-runtime");
    const result = await callWikiWithPayer(transport, "aaaaa-aa", "purchase_database_cycles", [{
      database_id: "db", payment_amount_e8s: 2n, min_expected_cycles: 3n
    }]);
    expect(result).toEqual({ Ok: { block_index: 42n, amount_cycles: 3n, balance_cycles: 6n } });
    expect(observed.walletSnapshot.transport).toBe(transport);
    expect(plug.requestConnect).toHaveBeenCalledTimes(1);
    expect(plug.disconnect).not.toHaveBeenCalled();
    await act(async () => { observed.disconnectWallet("plug"); });
    expect(plug.disconnect).toHaveBeenCalledTimes(1);
    expect(observed.walletSession.isCurrent(guard)).toBe(false);
    expect(observed.walletPaymentReady).toBe(false);
  });

  it("authorizes a restored Plug by gesture and checks out using the actual Marketplace facade", async () => {
    const owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
    const market = vi.fn(async () => ({ Ok: { order_id: "order", listing_id: "listing", database_id: "db", buyer_principal: owner.toText(),
      seller_principal: "aaaaa-aa", payout_principal: "aaaaa-aa", price_e8s: 1000000n, ledger_block_index: 19n, created_at_ms: 7n } }));
    const approve = vi.fn(async () => ({ Ok: 10n }));
    const plug = { requestConnect: vi.fn(async () => true), isConnected: async () => true,
      agent: { getPrincipal: async () => owner }, createActor: vi.fn(async () => ({ market_purchase_access: market, icrc2_approve: approve })),
      disconnect: vi.fn() };
    Object.defineProperty(window, "ic", { configurable: true, value: { plug } });
    sessionStorage.setItem("kinic-wiki.wallet-session", JSON.stringify({ provider: "plug", principal: owner.toText() }));
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);
    await waitFor(() => expect(observed.wallet?.provider).toBe("plug"));
    expect(observed.walletPaymentReady).toBe(false);
    expect(plug.requestConnect).not.toHaveBeenCalled();
    await act(async () => { await observed.connectWallet("plug"); });
    expect(observed.walletPaymentReady).toBe(true);
    expect(plug.requestConnect).toHaveBeenCalledTimes(1);
    expect(approve).not.toHaveBeenCalled();
    expect(market).not.toHaveBeenCalled();
    const wallet = observed.wallet!;
    const { purchaseMarketAccessWithFundingSource } = await vi.importActual<typeof import("@/lib/kinic-wallet")>("@/lib/kinic-wallet");
    const nativeActor = vi.spyOn(Actor, "createActor").mockReturnValueOnce({
      icrc2_allowance: async () => ({ allowance: 0n, expires_at: [] })
    } as unknown as ReturnType<typeof Actor.createActor>);
    try {
      const order = await purchaseMarketAccessWithFundingSource(
        { canisterId: "aaaaa-aa", listingId: "listing", priceE8s: 1000000n, accessPrincipal: "aaaaa-aa" }, wallet);
      expect(order).toMatchObject({ buyerPrincipal: owner.toText(), approveBlockIndex: "10", ledgerBlockIndex: "19" });
      expect(approve).toHaveBeenCalledTimes(1);
      expect(market).toHaveBeenCalledTimes(1);
      expect(plug.requestConnect).toHaveBeenCalledTimes(1);
      expect(plug.disconnect).not.toHaveBeenCalled();
    } finally { nativeActor.mockRestore(); }
  });

  it("re-enables explicit connection after a pending grant crosses pagehide and pageshow", async () => {
    const old = deferred<boolean>();
    const requestConnect = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(true);
    Object.defineProperty(window, "ic", { configurable: true, value: { plug: { requestConnect, isConnected: async () => true,
      agent: { getPrincipal: async () => Principal.fromText("aaaaa-aa") }, createActor: vi.fn() } } });
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);
    await waitFor(() => expect(observed.principal).toBe("aaaaa-aa"));
    let stale!: Promise<void>;
    act(() => { stale = observed.connectWallet("plug"); });
    await waitFor(() => expect(observed.walletBusyProvider).toBe("plug"));
    act(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
    await act(async () => { old.resolve(true); await stale; });
    expect(observed.wallet).toBeNull();
    expect(observed.walletBusyProvider).toBeNull();
    await act(async () => { await observed.connectWallet("plug"); });
    expect(requestConnect).toHaveBeenCalledTimes(2);
    expect(observed.walletPaymentReady).toBe(true);
  });

  it("discards a wallet balance response after disconnect", async () => {
    sessionStorage.setItem("kinic-wiki.wallet-session", JSON.stringify({ provider: "plug", principal: "ryjl3-tyaaa-aaaaa-aaaba-cai" }));
    const balance = deferred<string>();
    mocks.getConnectedWalletBalance.mockReturnValueOnce(balance.promise);
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);
    await waitFor(() => expect(mocks.getConnectedWalletBalance).toHaveBeenCalledTimes(1));

    const work = observed.walletSession.capture();
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    expect(observed.walletSession.isCurrent(work)).toBe(false);
    balance.resolve("999000000");

    await waitFor(() => expect(screen.getByTestId("wallet-principal").textContent).toBe("none"));
    expect(screen.getByTestId("wallet-balance").textContent).toBe("none");
  });

  it("ignores an invalid stored wallet and still marks restoration ready", async () => {
    sessionStorage.setItem("kinic-wiki.wallet-session", "invalid-json");
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);

    await waitFor(() => expect(screen.getByTestId("wallet-session-ready").textContent).toBe("true"));
    expect(screen.getByTestId("wallet-principal").textContent).toBe("none");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
