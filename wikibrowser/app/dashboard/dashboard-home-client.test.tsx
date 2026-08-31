// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardHomeClient } from "@/app/dashboard/dashboard-home-client";

const mocks = vi.hoisted(() => ({
  AfterApproveError: class AfterApproveError extends Error {
    causeMessage: string;

    constructor(causeMessage: string) {
      super(causeMessage);
      this.causeMessage = causeMessage;
    }
  },
  createDatabaseAuthenticated: vi.fn(),
  getCyclesBillingConfig: vi.fn(),
  getInitialFreeDatabaseGrantStatus: vi.fn(),
  identity: { getPrincipal: () => ({ toText: () => "principal-1" }) },
  listDatabasesAuthenticated: vi.fn(),
  listDatabasesPublic: vi.fn(),
  marketListEntitlements: vi.fn(),
  purchaseCyclesWithFundingSource: vi.fn(),
  push: vi.fn(),
  refreshIdentityLedgerBalance: vi.fn(),
  refreshWalletBalance: vi.fn(),
  replace: vi.fn(),
  session: {} as Record<string, unknown>
}));

vi.mock("@/lib/app-router", () => ({
  useAppNavigate: () => ({ push: mocks.push, replace: mocks.replace }),
  useAppSearchParams: () => new URLSearchParams()
}));

vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn() } }));

vi.mock("@/app/app-session-provider", () => ({
  connectedWalletPrincipal: (wallet: { provider: string; connection: { owner?: string; principal?: string } }) =>
    wallet.provider === "oisy" ? wallet.connection.owner : wallet.connection.principal,
  useAppSession: () => mocks.session
}));

vi.mock("@/components/admin-shell", () => ({
  AdminContent: ({ children }: { children: ReactNode }) => <main>{children}</main>
}));

vi.mock("@/app/home-ui", () => ({
  DatabaseBody: ({ createDatabaseAction }: { createDatabaseAction?: ReactNode }) => (
    <div data-testid="database-body">{createDatabaseAction}</div>
  ),
  StatusPanel: ({ message }: { message: string }) => <div role="alert">{message}</div>
}));

vi.mock("@/app/create-database-dialog", () => ({
  CreateDatabaseDialog: ({
    createDisabled,
    createLabel,
    databaseName,
    fundingRequired,
    fundingSourceContent,
    open,
    requiredBalanceLabel,
    onChange,
    onSubmit
  }: {
    createDisabled: boolean;
    createLabel: string;
    databaseName: string;
    fundingRequired: boolean;
    fundingSourceContent: ReactNode;
    open: boolean;
    requiredBalanceLabel: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
  }) => open ? (
    <dialog aria-label="Create database" open>
      <p>Requires {requiredBalanceLabel}.</p>
      {fundingRequired ? fundingSourceContent : null}
      <input aria-label="Database name" value={databaseName} onChange={(event) => onChange(event.target.value)} />
      <button disabled={createDisabled} type="button" onClick={onSubmit}>{createLabel}</button>
    </dialog>
  ) : null
}));

vi.mock("@/lib/vfs-client", () => ({
  createDatabaseAuthenticated: mocks.createDatabaseAuthenticated,
  getCyclesBillingConfig: mocks.getCyclesBillingConfig,
  getInitialFreeDatabaseGrantStatus: mocks.getInitialFreeDatabaseGrantStatus,
  listDatabasesAuthenticated: mocks.listDatabasesAuthenticated,
  listDatabasesPublic: mocks.listDatabasesPublic,
  marketListEntitlements: mocks.marketListEntitlements
}));

vi.mock("@/lib/kinic-wallet", () => ({
  KinicAfterApproveError: mocks.AfterApproveError,
  purchaseCyclesWithFundingSource: mocks.purchaseCyclesWithFundingSource
}));

const AVAILABLE_GRANT = {
  available: true,
  grantCycles: "10000000000",
  databaseId: null,
  createdAtMs: null
};

const USED_GRANT = {
  available: false,
  grantCycles: "10000000000",
  databaseId: "db_used",
  createdAtMs: "1"
};

beforeEach(() => {
  vi.stubEnv("VITE_KINIC_WIKI_CANISTER_ID", "aaaaa-aa");
  mocks.createDatabaseAuthenticated.mockReset().mockResolvedValue({
    database_id: "db_free",
    name: "Free database",
    status: "active",
    initial_free_grant_applied: true
  });
  mocks.getCyclesBillingConfig.mockReset().mockResolvedValue(null);
  mocks.getInitialFreeDatabaseGrantStatus.mockReset().mockResolvedValue(AVAILABLE_GRANT);
  mocks.listDatabasesAuthenticated.mockReset().mockResolvedValue([]);
  mocks.listDatabasesPublic.mockReset().mockResolvedValue([]);
  mocks.marketListEntitlements.mockReset().mockResolvedValue({ entitlements: [], nextCursor: null });
  mocks.purchaseCyclesWithFundingSource.mockReset().mockResolvedValue({
    purchasedCycles: "10000000000",
    paymentAmountE8s: "100000000"
  });
  mocks.push.mockReset();
  mocks.refreshIdentityLedgerBalance.mockReset();
  mocks.refreshWalletBalance.mockReset();
  mocks.replace.mockReset();
  mocks.session = {
    authClient: { getIdentity: () => mocks.identity },
    authError: null,
    authReady: true,
    identityLedgerBalance: null,
    identityLedgerBalanceError: null,
    identityLedgerBalanceLoading: false,
    principal: "principal-1",
    refreshIdentityLedgerBalance: mocks.refreshIdentityLedgerBalance,
    refreshWalletBalance: mocks.refreshWalletBalance,
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

describe("DashboardHomeClient database creation", () => {
  it("creates the initial free database without waiting for wallet state", async () => {
    mocks.session.walletBalanceLoading = true;
    mocks.session.walletBusyProvider = "oisy";
    render(<DashboardHomeClient />);

    const openButton = await enabledButton("Create database");
    fireEvent.click(openButton);
    expect(screen.queryByText(/Wallet balance:/)).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "Free database" } });
    const createButton = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
    fireEvent.click(createButton);

    await waitFor(() => expect(mocks.createDatabaseAuthenticated).toHaveBeenCalledTimes(1));
    expect(mocks.purchaseCyclesWithFundingSource).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/db/db_free/Knowledge"));
  });

  it("keeps wallet funding required after the free grant was used", async () => {
    mocks.getInitialFreeDatabaseGrantStatus.mockResolvedValue(USED_GRANT);
    render(<DashboardHomeClient />);

    const openButton = await enabledButton("Create database");
    fireEvent.click(openButton);
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "Paid database" } });

    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
    expect(screen.getByText("1.000 KINIC")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh balance" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Create with Internet Identity" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.createDatabaseAuthenticated).not.toHaveBeenCalled();
  });

  it("requires a full 1 KINIC wallet balance", async () => {
    mocks.getInitialFreeDatabaseGrantStatus.mockResolvedValue(USED_GRANT);
    mocks.session.wallet = { provider: "plug", connection: { principal: "wallet-a" } };
    mocks.session.walletBalance = "99999999";
    render(<DashboardHomeClient />);

    fireEvent.click(await enabledButton("Create database"));
    expect(screen.getByText("Requires 1.000 KINIC.")).toBeTruthy();
    expect(screen.getByText("0.999 KINIC")).toBeTruthy();
    expect(screen.getByText("This account needs at least 1.000 KINIC.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "Paid database" } });

    expect((screen.getByRole("button", { name: "Create with Plug" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows and refreshes an exact wallet balance", async () => {
    mocks.getInitialFreeDatabaseGrantStatus.mockResolvedValue(USED_GRANT);
    const wallet = { provider: "plug", connection: { principal: "wallet-a" } };
    mocks.session.wallet = wallet;
    mocks.session.walletBalance = "100000000";
    render(<DashboardHomeClient />);

    fireEvent.click(await enabledButton("Create database"));
    expect(screen.getAllByText("1.000 KINIC")).toHaveLength(2);
    const refreshButton = screen.getByRole("button", { name: "Refresh balance" }) as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(false);
    fireEvent.click(refreshButton);

    expect(mocks.refreshWalletBalance).toHaveBeenCalledTimes(1);
    expect(mocks.refreshWalletBalance).toHaveBeenCalledWith(wallet);
  });

  it("shows a wallet balance failure state", async () => {
    mocks.getInitialFreeDatabaseGrantStatus.mockResolvedValue(USED_GRANT);
    mocks.session.wallet = { provider: "plug", connection: { principal: "wallet-a" } };
    mocks.session.walletBalanceError = "KINIC balance unavailable";
    render(<DashboardHomeClient />);

    fireEvent.click(await enabledButton("Create database"));
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("This account needs at least 1.000 KINIC.")).toBeNull();
  });

  it("disables balance refresh while the balance is loading", async () => {
    mocks.getInitialFreeDatabaseGrantStatus.mockResolvedValue(USED_GRANT);
    mocks.session.wallet = { provider: "plug", connection: { principal: "wallet-a" } };
    mocks.session.walletBalanceLoading = true;
    render(<DashboardHomeClient />);

    fireEvent.click(await enabledButton("Create database"));
    expect(screen.getByText("Loading...")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refreshing..." }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a blocking free-grant error and retries the query", async () => {
    mocks.getInitialFreeDatabaseGrantStatus
      .mockRejectedValueOnce(new Error("grant query failed"))
      .mockResolvedValue(AVAILABLE_GRANT);
    mocks.listDatabasesAuthenticated.mockRejectedValueOnce(new Error("member list failed"));
    mocks.listDatabasesPublic.mockRejectedValueOnce(new Error("public list failed"));
    render(<DashboardHomeClient />);

    expect(await screen.findByText("Initial free database grant status unavailable: grant query failed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create database" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry free grant check" }));

    await waitFor(() => expect(mocks.getInitialFreeDatabaseGrantStatus).toHaveBeenCalledTimes(2));
    fireEvent.click(await enabledButton("Create database"));
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "Retried free database" } });
    const createButton = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
    fireEvent.click(createButton);

    await waitFor(() => expect(mocks.createDatabaseAuthenticated).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Initial free database grant status unavailable: grant query failed")).toBeNull();
  });

  it("uses a successful free-grant result when both database lists fail", async () => {
    mocks.listDatabasesAuthenticated.mockRejectedValueOnce(new Error("member list failed"));
    mocks.listDatabasesPublic.mockRejectedValueOnce(new Error("public list failed"));
    render(<DashboardHomeClient />);

    expect(await screen.findByText("public list failed; member list failed")).toBeTruthy();
    fireEvent.click(await enabledButton("Create database"));
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "Free database after list failure" } });
    const createButton = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
    fireEvent.click(createButton);

    await waitFor(() => expect(mocks.createDatabaseAuthenticated).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Retry free grant check" })).toBeNull();
  });

  it("leaves a stale free-grant result pending without requesting wallet approval", async () => {
    mocks.getInitialFreeDatabaseGrantStatus
      .mockResolvedValueOnce(AVAILABLE_GRANT)
      .mockResolvedValue(USED_GRANT);
    mocks.createDatabaseAuthenticated.mockResolvedValue({
      database_id: "db_pending",
      name: "Pending database",
      status: "pending",
      initial_free_grant_applied: false
    });
    const wallet = { provider: "plug", connection: { principal: "wallet-a" } };
    mocks.session.wallet = wallet;
    mocks.session.walletBalance = "1000000000000";
    mocks.session.walletBusyProvider = "oisy";
    render(<DashboardHomeClient />);

    fireEvent.click(await enabledButton("Create database"));
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "Pending database" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Database created pending. Fund it from Cycles before opening /Knowledge.")).toBeTruthy();
    await waitFor(() => expect(mocks.getInitialFreeDatabaseGrantStatus).toHaveBeenCalledTimes(2));
    expect(mocks.listDatabasesAuthenticated).toHaveBeenCalledTimes(2);
    expect(mocks.listDatabasesPublic).toHaveBeenCalledTimes(2);
    expect(mocks.purchaseCyclesWithFundingSource).not.toHaveBeenCalled();
    expect(mocks.refreshWalletBalance).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps wallet funding for a paid database create", async () => {
    mocks.getInitialFreeDatabaseGrantStatus.mockResolvedValue(USED_GRANT);
    mocks.createDatabaseAuthenticated.mockResolvedValue({
      database_id: "db_paid",
      name: "Paid database",
      status: "pending",
      initial_free_grant_applied: false
    });
    const wallet = { provider: "plug", connection: { principal: "wallet-a" } };
    mocks.session.wallet = wallet;
    mocks.session.walletBalance = "100000000";
    render(<DashboardHomeClient />);

    fireEvent.click(await enabledButton("Create database"));
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "Paid database" } });
    fireEvent.click(screen.getByRole("button", { name: "Create with Plug" }));

    await waitFor(() => expect(mocks.purchaseCyclesWithFundingSource).toHaveBeenCalledWith(
      { canisterId: "aaaaa-aa", databaseId: "db_paid", paymentAmountE8s: 99_800_000n },
      wallet
    ));
    expect(mocks.refreshWalletBalance).toHaveBeenCalledWith(wallet);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/db/db_paid/Knowledge"));
    expect(mocks.getInitialFreeDatabaseGrantStatus).toHaveBeenCalledTimes(2);
    expect(mocks.listDatabasesAuthenticated).toHaveBeenCalledTimes(2);
    expect(mocks.listDatabasesPublic).toHaveBeenCalledTimes(2);
  });

  it("creates a paid database directly from the Internet Identity account at the exact boundary", async () => {
    mocks.getInitialFreeDatabaseGrantStatus.mockResolvedValue(USED_GRANT);
    mocks.createDatabaseAuthenticated.mockResolvedValue({
      database_id: "db_ii_paid",
      name: "II paid database",
      status: "pending",
      initial_free_grant_applied: false
    });
    mocks.session.identityLedgerBalance = "100000000";
    render(<DashboardHomeClient />);

    fireEvent.click(await enabledButton("Create database"));
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "II paid database" } });
    const createButton = screen.getByRole("button", { name: "Create with Internet Identity" }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
    fireEvent.click(createButton);

    await waitFor(() => expect(mocks.purchaseCyclesWithFundingSource).toHaveBeenCalledWith(
      { canisterId: "aaaaa-aa", databaseId: "db_ii_paid", paymentAmountE8s: 99_800_000n },
      { provider: "ii", identity: mocks.identity }
    ));
    expect(mocks.refreshIdentityLedgerBalance).toHaveBeenCalledTimes(1);
    expect(mocks.refreshWalletBalance).not.toHaveBeenCalled();
  });

  it("uses provider-neutral wording when activation fails after KINIC approval", async () => {
    mocks.getInitialFreeDatabaseGrantStatus.mockResolvedValue(USED_GRANT);
    mocks.createDatabaseAuthenticated.mockResolvedValue({
      database_id: "db_pending_after_approve",
      name: "Pending after approve",
      status: "pending",
      initial_free_grant_applied: false
    });
    mocks.session.identityLedgerBalance = "100000000";
    mocks.purchaseCyclesWithFundingSource.mockRejectedValue(new mocks.AfterApproveError("canister rejected purchase"));
    render(<DashboardHomeClient />);

    fireEvent.click(await enabledButton("Create database"));
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "Pending after approve" } });
    fireEvent.click(screen.getByRole("button", { name: "Create with Internet Identity" }));

    expect(await screen.findByText(/KINIC approval did not activate it/)).toBeTruthy();
    expect(screen.queryByText(/wallet approval did not activate it/)).toBeNull();
  });

  it("does not navigate to a free database created for a previous principal", async () => {
    const createResult = deferred<{
      database_id: string;
      name: string;
      status: string;
      initial_free_grant_applied: boolean;
    }>();
    mocks.createDatabaseAuthenticated.mockReturnValue(createResult.promise);
    const rendered = render(<DashboardHomeClient />);

    fireEvent.click(await enabledButton("Create database"));
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "Old principal database" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mocks.createDatabaseAuthenticated).toHaveBeenCalledTimes(1));

    mocks.session.principal = "principal-2";
    rendered.rerender(<DashboardHomeClient />);
    createResult.resolve({
      database_id: "db_old_principal",
      name: "Old principal database",
      status: "active",
      initial_free_grant_applied: true
    });

    await enabledButton("Create database");
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.purchaseCyclesWithFundingSource).not.toHaveBeenCalled();
  });

  it("does not fund a pending database created for a previous principal", async () => {
    mocks.getInitialFreeDatabaseGrantStatus.mockResolvedValue(USED_GRANT);
    const wallet = { provider: "plug", connection: { principal: "wallet-a" } };
    mocks.session.wallet = wallet;
    mocks.session.walletBalance = "1000000000000";
    const createResult = deferred<{
      database_id: string;
      name: string;
      status: string;
      initial_free_grant_applied: boolean;
    }>();
    mocks.createDatabaseAuthenticated.mockReturnValue(createResult.promise);
    const rendered = render(<DashboardHomeClient />);

    fireEvent.click(await enabledButton("Create database"));
    fireEvent.change(screen.getByRole("textbox", { name: "Database name" }), { target: { value: "Old paid database" } });
    fireEvent.click(screen.getByRole("button", { name: "Create with Plug" }));
    await waitFor(() => expect(mocks.createDatabaseAuthenticated).toHaveBeenCalledTimes(1));

    mocks.session.principal = "principal-2";
    rendered.rerender(<DashboardHomeClient />);
    createResult.resolve({
      database_id: "db_old_paid",
      name: "Old paid database",
      status: "pending",
      initial_free_grant_applied: false
    });

    await enabledButton("Create database");
    expect(mocks.purchaseCyclesWithFundingSource).not.toHaveBeenCalled();
    expect(mocks.refreshWalletBalance).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function enabledButton(name: string): Promise<HTMLButtonElement> {
  const button = await screen.findByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}
