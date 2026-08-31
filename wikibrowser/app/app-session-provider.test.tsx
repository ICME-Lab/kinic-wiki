// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Identity } from "@icp-sdk/core/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSessionProvider, useAppSession } from "@/app/app-session-provider";

const mocks = vi.hoisted(() => {
  const identity = { getPrincipal: () => ({ toText: () => "ii-principal" }) };
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

vi.mock("@icp-sdk/auth/client", () => ({ AuthClient: { create: mocks.authCreate } }));
vi.mock("@/lib/kinic-wallet", () => ({
  connectOisyWallet: vi.fn(),
  connectPlugWallet: vi.fn(),
  getConnectedWalletKinicBalance: mocks.getConnectedWalletBalance,
  getPrincipalKinicLedgerBalance: mocks.getPrincipalBalance
}));

function SessionProbe() {
  const session = useAppSession();
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
      <button type="button" onClick={() => void session.refreshIdentityLedgerBalanceFor(mocks.identity as Identity, "ii-principal")}>Refresh captured II</button>
      <button type="button" onClick={() => void session.logout()}>Logout</button>
    </div>
  );
}

beforeEach(() => {
  sessionStorage.clear();
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

    await waitFor(() => expect(screen.getByTestId("principal").textContent).toBe("ii-principal"));
    await waitFor(() => expect(screen.getByTestId("balance").textContent).toBe("123000000"));
    expect(mocks.getPrincipalBalance).toHaveBeenCalledWith("aaaaa-aa", "ii-principal");

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
    sessionStorage.setItem("kinic-wiki.wallet-session", JSON.stringify({ provider: "plug", principal: "wallet-principal" }));
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);

    await waitFor(() => expect(screen.getByTestId("wallet-session-ready").textContent).toBe("true"));
    expect(screen.getByTestId("wallet-principal").textContent).toBe("wallet-principal");
  });

  it("discards a wallet balance response after disconnect", async () => {
    sessionStorage.setItem("kinic-wiki.wallet-session", JSON.stringify({ provider: "plug", principal: "wallet-principal" }));
    const balance = deferred<string>();
    mocks.getConnectedWalletBalance.mockReturnValueOnce(balance.promise);
    render(<AppSessionProvider><SessionProbe /></AppSessionProvider>);
    await waitFor(() => expect(mocks.getConnectedWalletBalance).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
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
