// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import type { Identity } from "@icp-sdk/core/agent";
import type { FundingTransport, WalletCall } from "@kinic/payments/wallet-types";
import type { WalletSessionSnapshot } from "@kinic/payments/wallet-session";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CyclesClient } from "@/app/cycles/cycles-client";

const mocks = vi.hoisted(() => ({
  config: { kinicLedgerCanisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai", cyclesPerKinic: "234500000000", minUpdateCycles: "1" },
  listDatabases: vi.fn(), terms: vi.fn(), pending: vi.fn(), history: vi.fn(), purchase: vi.fn(), approve: vi.fn(),
  replace: vi.fn(), session: {} as Record<string, unknown>, generation: 0,
  facts: { decimals: 8, feeE8s: 100000n, balanceE8s: 100200000n, allowanceE8s: 0n, allowanceExpiresAtNs: null },
}));
vi.mock("@/lib/app-router", () => ({ useAppNavigate: () => ({ replace: mocks.replace }) }));
vi.mock("@/app/app-session-provider", () => ({ useAppSession: () => mocks.session }));
vi.mock("@kinic/payments/ledger", async importOriginal => ({ ...await importOriginal<object>(), readLedgerTerms: mocks.terms }));
vi.mock("@/lib/vfs-client", () => ({
  getCyclesBillingConfig: async () => mocks.config, listDatabasesAuthenticated: mocks.listDatabases,
  listDatabaseCyclesPendingPurchasesAuthenticated: mocks.pending, listDatabaseCycleEntries: mocks.history,
}));
const iiOwner = "aaaaa-aa";
const plugOwner = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const identity = { getPrincipal: () => Principal.fromText(iiOwner) } as Identity;
let snapshot: WalletSessionSnapshot;
function transport(provider: "ii" | "plug", owner: string): FundingTransport {
  return { account: { provider, owner }, silentCheck: true, revalidate: async () => {}, disconnect: async () => {},
    approve: mocks.approve,
    async call(request: WalletCall) {
      if (request.isCurrent && !request.isCurrent()) throw new Error("stale session");
      const signature = request.interfaceFactory({ IDL })._fields.find(([name]) => name === request.method)![1];
      const args = IDL.decode(signature.argTypes, request.arg);
      const result = request.method === "purchase_database_cycles" ? await mocks.purchase(...args) : { Ok: [] };
      return IDL.encode(signature.retTypes, [result]);
    }
  };
}
const manager = {
  capture: () => mocks.generation,
  isCurrent: (token: unknown) => token === mocks.generation,
  getSnapshot: () => snapshot,
  hasScopes: () => true,
  getIdentityTransport: () => transport("ii", iiOwner),
};
function connectPlug() {
  snapshot = { state: "connected", account: { provider: "plug", owner: plugOwner }, transport: transport("plug", plugOwner), generation: mocks.generation };
  mocks.session.walletSnapshot = snapshot;
  mocks.session.walletPaymentReady = true;
}
beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_KINIC_WIKI_CANISTER_ID", iiOwner);
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, _options: object, run: (lock: object) => Promise<void>) => run({}) } });
  mocks.generation = 0;
  snapshot = { state: "disconnected", account: null, transport: null, generation: 0 };
  mocks.facts = { decimals: 8, feeE8s: 100000n, balanceE8s: 100200000n, allowanceE8s: 0n, allowanceExpiresAtNs: null };
  mocks.terms.mockReset().mockImplementation(async () => mocks.facts);
  mocks.listDatabases.mockReset().mockResolvedValue([{ databaseId: "db-1", status: "active", role: "owner", cyclesBalance: "234500000000", metadata: { name: "Database" } }]);
  mocks.pending.mockReset().mockResolvedValue([]);
  mocks.history.mockReset().mockResolvedValue({ entries: [], nextCursor: null });
  mocks.approve.mockReset().mockImplementation(async () => { mocks.facts.balanceE8s -= 100000n; mocks.facts.allowanceE8s = 100100000n; return 1n; });
  mocks.purchase.mockReset().mockResolvedValue({ Ok: { block_index: 7n, amount_cycles: 234500000000n, balance_cycles: 234500000000n } });
  mocks.replace.mockReset();
  mocks.session = { authClient: { getIdentity: () => identity }, principal: iiOwner, authReady: true, authLoading: false,
    walletSession: manager, walletSnapshot: snapshot, walletPaymentReady: false,
    identityLedgerBalance: "100200000", walletBalance: "100200000", login: vi.fn(), connectWallet: vi.fn(), disconnectWallet: vi.fn(),
    setAuthControlsLocked: vi.fn(), setWalletControlsLocked: vi.fn() };
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
const page = (databaseId = "db-1") => <CyclesClient canisterId={iiOwner} databaseId={databaseId} databaseStatus="active" />;
async function review() {
  const button = await screen.findByRole("button", { name: "Review payment" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}
async function pay() {
  const button = await screen.findByRole("button", { name: "Pay 1 KINIC" });
  fireEvent.click(button);
}
it("reviews the exact amount plus two fees and requires a separate confirmation", async () => {
  render(page());
  await review();
  expect(await screen.findByRole("button", { name: "Pay 1 KINIC" })).toBeTruthy();
  expect(screen.getByText("1.002 KINIC")).toBeTruthy();
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.purchase).not.toHaveBeenCalled();
  await pay();
  expect(await screen.findByText("Payment complete")).toBeTruthy();
  expect(mocks.approve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 100100000n, fee: [100000n] }), expect.anything());
  expect(mocks.purchase).toHaveBeenCalledWith({ database_id: "db-1", payment_amount_e8s: 100000000n, min_expected_cycles: 234500000000n });
  expect(mocks.replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "View database" }));
  expect(mocks.replace).toHaveBeenCalledWith(expect.stringContaining("database_id=db-1"));
});
it("refuses one base unit below the required balance before approval", async () => {
  mocks.facts.balanceE8s = 100199999n;
  render(page());
  await review();
  expect(await screen.findByText(/not enough KINIC/)).toBeTruthy();
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.purchase).not.toHaveBeenCalled();
});
it("prefers a connected wallet and pays from its account", async () => {
  connectPlug();
  render(page());
  await review();
  await pay();
  expect(await screen.findByText("Payment complete")).toBeTruthy();
  expect(mocks.terms).toHaveBeenCalledWith(expect.objectContaining({ owner: plugOwner }));
});
it("recreates confirmation after a same-provider wallet generation changes", async () => {
  connectPlug();
  const view = render(page());
  await review();
  await screen.findByRole("button", { name: "Pay 1 KINIC" });
  mocks.generation++;
  connectPlug();
  view.rerender(page());
  await waitFor(() => expect((screen.getByRole("button", { name: "Review payment" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole("button", { name: "Pay 1 KINIC" })).toBeNull();
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.purchase).not.toHaveBeenCalled();
});
it("allows a newly connected wallet to be selected without Internet Identity", async () => {
  mocks.session.principal = null;
  mocks.session.authClient = null;
  const view = render(page());
  connectPlug();
  view.rerender(page());
  fireEvent.click(screen.getByRole("radio", { name: "Plug" }));
  await review();
  await pay();
  expect(await screen.findByText("Payment complete")).toBeTruthy();
  expect(mocks.purchase).toHaveBeenCalledTimes(1);
});
it("funds a validated unlinked URL target using a wallet while signed in", async () => {
  connectPlug();
  mocks.history.mockRejectedValue(new Error("principal has no access to database: other"));
  mocks.pending.mockRejectedValue(new Error("principal cannot view pending cycle purchases: other"));
  render(page("other"));
  await review();
  await pay();
  expect(await screen.findByText("Payment complete")).toBeTruthy();
  expect(mocks.purchase).toHaveBeenCalledWith(expect.objectContaining({ database_id: "other" }));
});
it("blocks new payment review for a known deleted target", async () => {
  mocks.listDatabases.mockResolvedValue([{ databaseId: "db-1", status: "deleted", metadata: { name: "Deleted" } }]);
  render(page());
  await waitFor(() => expect(mocks.listDatabases).toHaveBeenCalled());
  await act(async () => {});
  expect((screen.getByRole("button", { name: "Review payment" }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.terms).not.toHaveBeenCalled();
});
it("retains saved payment checks after the target becomes unavailable", async () => {
  mocks.purchase.mockRejectedValue(new Error("reply lost"));
  const first = render(page());
  await review();
  await pay();
  await screen.findByText("Payment needs a status check");
  first.unmount();
  mocks.listDatabases.mockResolvedValue([{ databaseId: "db-1", status: "deleted", metadata: { name: "Deleted" } }]);
  render(page());
  fireEvent.click(await screen.findByRole("button", { name: "Check payment status" }));
  expect(screen.queryByRole("button", { name: "Pay 1 KINIC" })).toBeNull();
  expect(mocks.purchase).toHaveBeenCalledTimes(1);
});
it("returns to editable terms before any approval", async () => {
  render(page());
  await review();
  fireEvent.click(await screen.findByRole("button", { name: "Edit payment" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "KINIC amount" }) as HTMLInputElement).disabled).toBe(false));
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("offers a status check instead of promising edits after an approval was saved", async () => {
  mocks.approve.mockImplementation(async () => {
    mocks.facts.balanceE8s = 0n;
    mocks.facts.allowanceE8s = 100100000n;
    return 1n;
  });
  render(page());
  await review();
  await pay();
  fireEvent.click(await screen.findByRole("button", { name: "Check payment status" }));
  await screen.findByRole("button", { name: "Pay 1 KINIC" });
  expect(screen.queryByRole("button", { name: "Edit payment" })).toBeNull();
  expect(screen.getByRole("button", { name: "Check payment status" })).toBeTruthy();
  expect(mocks.purchase).not.toHaveBeenCalled();
});
it("keeps a confirmed receipt when the refreshed credit balance is unavailable", async () => {
  render(page());
  await review();
  mocks.listDatabases.mockRejectedValueOnce(new Error("balance offline"));
  await pay();
  expect(await screen.findByText("Payment complete")).toBeTruthy();
  expect(screen.getByText(/Balance unavailable/)).toBeTruthy();
  expect(mocks.purchase).toHaveBeenCalledTimes(1);
});
it("keeps a lost payment reply unresolved without offering another purchase", async () => {
  mocks.purchase.mockRejectedValue(new Error("reply lost"));
  render(page());
  await review();
  await pay();
  expect(await screen.findByText("Payment needs a status check")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Pay 1 KINIC" })).toBeNull();
  expect(mocks.purchase).toHaveBeenCalledTimes(1);
});
it("locks authentication while confirming or paying", async () => {
  const pending = deferred<{ Ok: { block_index: bigint; amount_cycles: bigint; balance_cycles: bigint } }>();
  mocks.purchase.mockReturnValue(pending.promise);
  render(page());
  await review();
  await waitFor(() => expect(mocks.session.setAuthControlsLocked).toHaveBeenLastCalledWith(true));
  await pay();
  await act(async () => pending.resolve({ Ok: { block_index: 7n, amount_cycles: 234500000000n, balance_cycles: 234500000000n } }));
  await waitFor(() => expect(mocks.session.setAuthControlsLocked).toHaveBeenLastCalledWith(false));
});
it.each(["principal", "wallet", "route"])("discards a delayed purchase reply after the %s changes", async change => {
  const pending = deferred<{ Ok: { block_index: bigint; amount_cycles: bigint; balance_cycles: bigint } }>();
  mocks.purchase.mockReturnValue(pending.promise);
  if (change === "wallet") connectPlug();
  const view = render(page());
  await review();
  await pay();
  await waitFor(() => expect(mocks.purchase).toHaveBeenCalledTimes(1));
  mocks.generation++;
  if (change === "principal") mocks.session.principal = plugOwner;
  snapshot = { ...snapshot, generation: mocks.generation };
  mocks.session.walletSnapshot = snapshot;
  view.rerender(page(change === "route" ? "other" : "db-1"));
  await act(async () => pending.resolve({ Ok: { block_index: 7n, amount_cycles: 234500000000n, balance_cycles: 234500000000n } }));
  expect(screen.queryByText("Payment complete")).toBeNull();
  expect(mocks.replace).not.toHaveBeenCalled();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("locks the wallet-only sign-in action while confirming and while approval is held", async () => {
  mocks.session.principal = null; mocks.session.authClient = null; connectPlug();
  const approval = deferred<bigint>(); mocks.approve.mockReturnValueOnce(approval.promise);
  render(page()); await review(); await screen.findByRole("button",{name:"Pay 1 KINIC"});
  const login = screen.getByRole("button",{name:"Sign in with Internet Identity"});
  expect(login).toHaveProperty("disabled",true);fireEvent.click(login);
  await pay();await screen.findByText("Approving");
  expect(login).toHaveProperty("disabled",true);fireEvent.click(login);
  expect(mocks.session.login).not.toHaveBeenCalled();
  await act(async()=>approval.resolve(1n));
});
it("shows the billing authority, known operation and completion of an unchanged pending check",async()=>{
  mocks.purchase.mockResolvedValue({Err:"icrc2_transfer_from result ambiguous for operation_id 47; check status"});
  render(page());await review();await pay();await screen.findByText(/billing authority.*47/i);
  fireEvent.click(screen.getByRole("button",{name:"Check payment status"}));
  expect(await screen.findByText(/Status checked.*billing authority.*47/i)).toBeTruthy();
  expect(mocks.purchase).toHaveBeenCalledOnce();expect(mocks.approve).toHaveBeenCalledOnce();
});
it("retries only local cleanup on a confirmed Wiki receipt",async()=>{
  const remove=Storage.prototype.removeItem;
  const spy=vi.spyOn(Storage.prototype,"removeItem").mockImplementationOnce(()=>{throw Error("read only");});
  try {
    render(page());await review();
    mocks.listDatabases.mockRejectedValueOnce(new Error("balance offline"));
    await pay();await screen.findByText("Payment complete");
    expect(screen.getByText(/Balance unavailable/)).toBeTruthy();
    expect(screen.getByRole("button",{name:"Check payment status"})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"Refresh credit balance"}));
    await waitFor(()=>expect(screen.queryByText(/Balance unavailable/)).toBeNull());
    const updates = mocks.terms.mock.calls.length;
    const historyReads = mocks.history.mock.calls.length;

    fireEvent.click(screen.getByRole("button",{name:"Check payment status"}));
    await waitFor(()=>expect(screen.queryByRole("button",{name:"Check payment status"})).toBeNull());
    expect(mocks.terms.mock.calls).toHaveLength(updates);expect(mocks.history.mock.calls).toHaveLength(historyReads);
    expect(Object.keys(localStorage).filter(key=>key.startsWith("kinic.payments.v1:"))).toHaveLength(0);
    expect(mocks.purchase).toHaveBeenCalledOnce();expect(mocks.approve).toHaveBeenCalledOnce();
  } finally {spy.mockImplementation(remove);spy.mockRestore();}
});
