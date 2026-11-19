import { IDL } from "@icp-sdk/core/candid";
import type { WalletSessionManager } from "@kinic/payments/wallet-session";
import type { FundingTransport, WalletCall } from "@kinic/payments/wallet-types";
import { Principal } from "@icp-sdk/core/principal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConnectedWalletKinicBalance,
  KinicAfterApproveError,
  transferKinicFromIdentity,
  purchaseCyclesWithIdentity,
  purchaseMarketAccessWithIdentity,
  purchaseMarketAccessWithOisy
} from "@/lib/kinic-wallet";

const mocks = vi.hoisted(() => ({
  createActor: vi.fn(),
  createAuthenticatedActor: vi.fn(),
  getCyclesBillingConfig: vi.fn(),
  ledgerAllowance: vi.fn(),
  ledgerApprove: vi.fn(),
  marketPurchase: vi.fn(),
  purchaseCycles: vi.fn()
}));

vi.mock("@icp-sdk/core/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@icp-sdk/core/agent")>();
  return {
    ...actual,
    Actor: { ...actual.Actor, createActor: mocks.createActor },
    HttpAgent: {
      ...actual.HttpAgent,
      createSync: () => ({ fetchRootKey: vi.fn(), isLocal: () => false })
    }
  };
});

vi.mock("@/lib/vfs-client/actor", () => ({ createAuthenticatedActor: mocks.createAuthenticatedActor }));
vi.mock("@/lib/vfs-client", () => ({
  getCyclesBillingConfig: mocks.getCyclesBillingConfig
}));

const VFS_CANISTER_ID = "aaaaa-aa";
const LEDGER_CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const identity = {
  getPrincipal: () => Principal.fromText("2vxsx-fae"),
  transformRequest: vi.fn()
};

beforeEach(() => {
  vi.stubEnv("VITE_KINIC_WIKI_CANISTER_ID", VFS_CANISTER_ID);
  mocks.getCyclesBillingConfig.mockReset().mockResolvedValue({
    cyclesPerKinic: "234500000000",
    kinicLedgerCanisterId: LEDGER_CANISTER_ID
  });
  mocks.ledgerAllowance.mockReset().mockResolvedValue({ allowance: 0n, expires_at: [] });
  mocks.ledgerApprove.mockReset().mockResolvedValue({ Ok: 77n });
  mocks.purchaseCycles.mockReset().mockResolvedValue({
    Ok: { amount_cycles: 234_500_000_000n, balance_cycles: 300_000_000_000n, block_index: 88n }
  });
  mocks.marketPurchase.mockReset().mockResolvedValue({
    Ok: {
      order_id: "order-1",
      listing_id: "listing-1",
      database_id: "db-1",
      buyer_principal: "2vxsx-fae",
      seller_principal: "aaaaa-aa",
      payout_principal: "aaaaa-aa",
      price_e8s: 50_000_000n,
      ledger_block_index: 99n,
      created_at_ms: 1n
    }
  });
  mocks.createActor.mockReset().mockImplementation(() => ({
    icrc2_allowance: mocks.ledgerAllowance,
    icrc2_approve: mocks.ledgerApprove
  }));
  mocks.createAuthenticatedActor.mockReset().mockResolvedValue({
    market_purchase_access: mocks.marketPurchase,
    purchase_database_cycles: mocks.purchaseCycles
  });
});

describe("Internet Identity KINIC purchases", () => {
  it("approves before purchasing cycles with the same identity", async () => {
    const result = await purchaseCyclesWithIdentity(
      { canisterId: VFS_CANISTER_ID, databaseId: "db-1", paymentAmountE8s: 99_800_000n },
      identity
    );

    expect(mocks.ledgerApprove).toHaveBeenCalledTimes(1);
    expect(mocks.ledgerApprove.mock.calls[0]?.[0]).toMatchObject({ amount: 99_900_000n });
    expect(mocks.createAuthenticatedActor).toHaveBeenCalledWith(VFS_CANISTER_ID, identity);
    expect(mocks.purchaseCycles).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ provider: "ii", approveBlockIndex: "77", purchaseBlockIndex: "88" });
  });

  it("reuses an unexpired allowance without approving again", async () => {
    mocks.ledgerAllowance.mockResolvedValue({ allowance: 100_000_000n, expires_at: [] });
    const result = await purchaseCyclesWithIdentity(
      { canisterId: VFS_CANISTER_ID, databaseId: "db-1", paymentAmountE8s: 99_800_000n },
      identity
    );

    expect(mocks.ledgerApprove).not.toHaveBeenCalled();
    expect(result.approveBlockIndex).toBeNull();
    expect(mocks.purchaseCycles).toHaveBeenCalledTimes(1);
  });

  it("approves and purchases Marketplace access through the identity actor", async () => {
    const result = await purchaseMarketAccessWithIdentity(
      { canisterId: VFS_CANISTER_ID, listingId: "listing-1", priceE8s: 50_000_000n, accessPrincipal: "2vxsx-fae" },
      identity
    );

    expect(mocks.ledgerApprove).toHaveBeenCalledTimes(1);
    expect(mocks.marketPurchase).toHaveBeenCalledWith({
      listing_id: "listing-1",
      price_e8s: 50_000_000n,
      access_principal: "2vxsx-fae"
    });
    expect(result).toMatchObject({ provider: "ii", orderId: "order-1", ledgerBlockIndex: "99" });
  });

  it("stops before the purchase when approval fails", async () => {
    mocks.ledgerApprove.mockResolvedValue({ Err: { TemporarilyUnavailable: null } });
    await expect(
      purchaseCyclesWithIdentity(
        { canisterId: VFS_CANISTER_ID, databaseId: "db-1", paymentAmountE8s: 99_800_000n },
        identity
      )
    ).rejects.toThrow("ledger approve failed");
    expect(mocks.createAuthenticatedActor).not.toHaveBeenCalled();
    expect(mocks.purchaseCycles).not.toHaveBeenCalled();
  });

  it("reports an after-approve failure without trying another account", async () => {
    mocks.purchaseCycles.mockRejectedValue(new Error("purchase unavailable"));
    await expect(
      purchaseCyclesWithIdentity(
        { canisterId: VFS_CANISTER_ID, databaseId: "db-1", paymentAmountE8s: 99_800_000n },
        identity
      )
    ).rejects.toBeInstanceOf(KinicAfterApproveError);
    expect(mocks.ledgerApprove).toHaveBeenCalledTimes(1);
    expect(mocks.purchaseCycles).toHaveBeenCalledTimes(1);
  });
});


it("rejects an unsupported subaccount before reading its owner balance", async () => {
  const connection = { owner: VFS_CANISTER_ID, subaccount: Uint8Array.of(1) };
  await expect(getConnectedWalletKinicBalance(VFS_CANISTER_ID, { provider: "oisy", connection }))
    .rejects.toThrow("default ledger account");
  expect(mocks.getCyclesBillingConfig).not.toHaveBeenCalled();
  expect(mocks.createActor).not.toHaveBeenCalled();
});

it("retains the direct-send recipient, explicit fee, block result and ledger errors", async () => {
  const transfer = vi.fn().mockResolvedValueOnce({ Ok: 303n }).mockResolvedValueOnce({ Err: { TemporarilyUnavailable: null } });
  mocks.createActor.mockImplementation(() => ({ icrc1_transfer: transfer }));
  const request = { canisterId: VFS_CANISTER_ID, identity, toPrincipal: LEDGER_CANISTER_ID, amountE8s: 44n };
  expect(await transferKinicFromIdentity(request)).toBe("303");
  expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 44n, fee: [100000n],
    to: { owner: Principal.fromText(LEDGER_CANISTER_ID), subaccount: [] } }));
  await expect(transferKinicFromIdentity(request)).rejects.toThrow("ledger transfer failed: TemporarilyUnavailable");
});


it("retains the root-owned OISY signer after Marketplace success and purchase failure", async () => {
  const order = (await mocks.marketPurchase()).Ok;
  const transport: FundingTransport = {
    account: { provider: "oisy", owner: VFS_CANISTER_ID }, silentCheck: false, approve: vi.fn(async () => 77n),
    call: vi.fn(async (request: WalletCall) => {
      const fn = request.interfaceFactory({ IDL })._fields.find(([name]) => name === request.method)![1];
      return IDL.encode(fn.retTypes, [{ Ok: order }]);
    }),
    disconnect: vi.fn(async () => {}), revalidate: vi.fn(async () => {})
  };
  const session = { revalidate: vi.fn(async () => transport), disconnect: vi.fn() };
  const connection = { owner: VFS_CANISTER_ID, transport, session: session as unknown as WalletSessionManager };
  const request = { canisterId: VFS_CANISTER_ID, listingId: "listing-1", priceE8s: 50000000n, accessPrincipal: VFS_CANISTER_ID };
  expect(await purchaseMarketAccessWithOisy(request, connection)).toMatchObject({ provider: "oisy", orderId: "order-1", approveBlockIndex: "77", ledgerBlockIndex: "99" });
  vi.mocked(transport.call).mockRejectedValueOnce(new Error("reply lost"));
  await expect(purchaseMarketAccessWithOisy(request, connection)).rejects.toBeInstanceOf(KinicAfterApproveError);
  expect(transport.disconnect).not.toHaveBeenCalled();
  expect(session.disconnect).not.toHaveBeenCalled();
});
