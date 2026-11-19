import { afterEach, expect, it, vi } from "vitest";
import { createPaymentController } from "../src/controller";
import { recoveryTargetKey, createRecoveryStore } from "../src/recovery-store";
import { freezeTerms } from "../src/terms";
import type { PaymentAdapter, PaymentCheck, PaymentScope, RecoveryRecord } from "../src/types";

const scope: PaymentScope = {
  origin: "https://vault.example", host: "https://icp0.io", ledger: "aaaaa-aa", spender: "2vxsx-fae",
  payer: { provider: "ii", owner: "aaaaa-aa" }, target: { kind: "vault", beneficiary: "2vxsx-fae" },
};
const paid: PaymentCheck = { kind: "paid", receipt: { reference: "block:15", creditedCycles: 50n } };
const pending: PaymentCheck = { kind: "pending", reference: "purchase-1", requiredAction: "review" };
const record: RecoveryRecord = {
  version: 1, scope, id: "p1", stage: "purchase-dispatched", context: { operation: "p1" },
};
function fixture() {
  let generation = 1;
  let clockNs = 10n;
  const guard = { capture: () => generation, isCurrent: (token: unknown) => token === generation };
  const data = new Map<string, string>();
  const storage = {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: vi.fn((key: string) => { data.delete(key); }),
  };
  const store = createRecoveryStore(storage);
  const terms = freezeTerms({
    scope, id: "p1", recipient: "aaaaa-aa", context: { operation: "p1" },
    amountE8s: 30n, transferFeeE8s: 2n, approvalFeeE8s: 1n, allowanceE8s: 0n,
    approvalRequired: true, expiresAtNs: 100n, credits: 50n,
  }, "p1");
  const adapter = {
    scope, capabilities: { silentCheck: false, cancelUnsubmitted: true, scan: false } as PaymentAdapter<unknown>["capabilities"],
    prepare: vi.fn(async () => terms),
    revalidate: vi.fn(async (): Promise<"unchanged" | "changed"> => "unchanged"),
    approve: vi.fn(async () => {}), submit: vi.fn(async (): Promise<PaymentCheck> => paid),
    check: vi.fn(async (_r: RecoveryRecord): Promise<PaymentCheck> => pending),
    refreshCredit: vi.fn(async () => 90n),
    encode: vi.fn(() => ({ operation: "p1" })),
    restore: vi.fn(async (_r: RecoveryRecord) => terms), cancel: vi.fn(async () => {}),
  } satisfies PaymentAdapter<{ operation: string }>;
  const locks = {
    request: async (_key: string, _options: { ifAvailable: true }, action: (lock: object | null) => Promise<void>) => action({}),
  };
  const make = (lockManager: typeof locks | null = locks) =>
    createPaymentController({ adapter, guard, store, locks: lockManager, nowNs: () => clockNs });
  const controller = make();
  const prepare = () => controller.prepare(30n);
  const pay = () => controller.pay(terms.termsKey);
  return { adapter, controller, store, storage, data, terms, prepare, pay, make, setTime: (value: bigint) => { clockNs = value; }, invalidate: () => { generation++; } };
}
afterEach(() => vi.useRealTimers());

it("lost_purchase_reply_never_resubmits", async () => {
  const { adapter, controller, prepare, pay, store } = fixture();
  adapter.approve.mockImplementation(async () => {
    expect(store.list(scope)[0].stage).toBe("approval-dispatched");
  });
  adapter.submit.mockImplementation(async () => {
    expect(store.list(scope)[0].stage).toBe("purchase-dispatched");
    throw new Error("timed out");
  });
  await prepare();
  await pay();
  expect(controller.getState()).toMatchObject({ phase: "unresolved", error: { stage: "paying", code: "Unknown" } });
  await controller.check();
  await pay();
  await prepare();
  await controller.cancelUnsubmitted();
  expect(adapter.submit).toHaveBeenCalledTimes(1);
  expect(adapter.prepare).toHaveBeenCalledTimes(1);
  expect(adapter.cancel).not.toHaveBeenCalled();
  expect(store.list(scope)[0].stage).toBe("purchase-dispatched");
  expect(controller.getState()).toMatchObject({ phase: "unresolved", requiredAction: "review", reference: "purchase-1" });
});

it("two synchronous confirmations charge a single approval and submit only once", async () => {
  const { adapter, prepare, pay, controller } = fixture();
  await prepare();
  await Promise.all([pay(), pay()]);
  expect(adapter.approve).toHaveBeenCalledTimes(1);
  expect(adapter.submit).toHaveBeenCalledTimes(1);
  expect(controller.getState()).toMatchObject({ phase: "complete", receipt: paid.receipt, balance: 90n });
});

it.each([false, true])("invalidates changed terms before dispatch, including after approval %s", async after => {
  const { adapter, prepare, pay, controller } = fixture();
  if (after) adapter.revalidate.mockResolvedValueOnce("unchanged");
  adapter.revalidate.mockResolvedValue("changed");
  await prepare();
  await pay();
  await pay();
  expect(adapter.approve).toHaveBeenCalledTimes(after ? 1 : 0);
  expect(adapter.submit).not.toHaveBeenCalled();
  expect(controller.getState().error?.code).toBe("TermsChanged");
});

it("expired terms and a stale confirmation never charge an approval fee", async () => {
  const { adapter, controller, prepare, pay, terms } = fixture();
  await prepare();
  await controller.pay("stale");
  adapter.prepare.mockResolvedValue(Object.freeze({ ...terms, expiresAtNs: 10n }));
  await prepare();
  await pay();
  expect(adapter.approve).not.toHaveBeenCalled();
  expect(controller.getState().error?.code).toBe("Expired");
});

it("account invalidation during approval prevents submit and further state publication", async () => {
  const { adapter, prepare, pay, invalidate, controller, store } = fixture();
  adapter.approve.mockImplementation(async () => { invalidate(); });
  await prepare();
  await pay();
  expect(adapter.submit).not.toHaveBeenCalled();
  expect(store.list(scope)[0].stage).toBe("approval-dispatched");
  expect(controller.getState().phase).toBe("approving");
});

it("an approval rejection retains its stage and allowlisted cause", async () => {
  const { adapter, prepare, pay, controller } = fixture();
  adapter.approve.mockRejectedValue({ InsufficientFunds: { balance: 0n } });
  await prepare();
  await pay();
  expect(controller.getState()).toMatchObject({ phase: "failed", error: { stage: "approving", code: "InsufficientFunds" } });
  expect(adapter.submit).not.toHaveBeenCalled();
});

it("balance failure retains the paid receipt and only a balance read is retried", async () => {
  const { adapter, prepare, pay, controller } = fixture();
  adapter.refreshCredit.mockRejectedValueOnce(new Error("offline"));
  await prepare();
  await pay();
  expect(controller.getState()).toMatchObject({ phase: "complete", receipt: paid.receipt, balanceUnavailable: true });
  await controller.refreshBalance();
  expect(controller.getState()).toMatchObject({ phase: "complete", receipt: paid.receipt, balance: 90n });
  expect(controller.getState().balanceUnavailable).toBeUndefined();
  expect(adapter.submit).toHaveBeenCalledTimes(1);
});

it("a restored interactive operation requires a user check and cannot enable payment on a pending result", async () => {
  vi.useFakeTimers();
  const { adapter, store, make } = fixture();
  store.put(record);
  const reloaded = make();
  await vi.advanceTimersByTimeAsync(4_000);
  await reloaded.prepare(30n);
  expect(adapter.restore).not.toHaveBeenCalled();
  expect(adapter.check).not.toHaveBeenCalled();
  expect(adapter.prepare).not.toHaveBeenCalled();
  await reloaded.check();
  expect(adapter.check).toHaveBeenCalledWith(record);
  expect(adapter.submit).not.toHaveBeenCalled();
  expect(reloaded.getState().phase).toBe("unresolved");
});

it("an ambiguous approval checks its own marker and never repeats the approval on a Quoted status", async () => {
  const { adapter, prepare, pay, controller, store } = fixture();
  adapter.approve.mockRejectedValue(new Error("reply lost"));
  adapter.check.mockResolvedValue({ kind: "unsubmitted", expired: false });
  await prepare();
  await pay();
  await controller.check();
  await pay();
  expect(adapter.check).toHaveBeenCalledWith(expect.objectContaining({ stage: "approval-dispatched" }));
  expect(adapter.approve).toHaveBeenCalledTimes(1);
  expect(adapter.submit).not.toHaveBeenCalled();
  expect(store.list(scope)[0].stage).toBe("approval-dispatched");
});

it("a purchase marker stays locked when status temporarily appears unsubmitted", async () => {
  const { adapter, store, make, terms } = fixture();
  store.put(record);
  adapter.check.mockResolvedValue({ kind: "unsubmitted", expired: false });
  const reloaded = make();
  await reloaded.check();
  await reloaded.cancelUnsubmitted();
  await reloaded.pay(terms.termsKey);
  expect(adapter.cancel).not.toHaveBeenCalled();
  expect(adapter.submit).not.toHaveBeenCalled();
  expect(store.list(scope)).toEqual([record]);
});

it("a stored original quote can be reviewed and explicitly cancelled only after a status check", async () => {
  const { adapter, store, make } = fixture();
  store.put({ ...record, stage: "quote-dispatched" });
  adapter.check.mockResolvedValue({ kind: "unsubmitted", expired: true });
  const reloaded = make();
  await reloaded.cancelUnsubmitted();
  expect(adapter.cancel).not.toHaveBeenCalled();
  await reloaded.check();
  expect(reloaded.getState()).toMatchObject({ canCancelUnsubmitted: true, error: { code: "Expired" } });
  await reloaded.cancelUnsubmitted();
  expect(adapter.cancel).toHaveBeenCalledTimes(1);
  expect(store.list(scope)).toEqual([]);
});

it("storage failure before either dispatch stops that charge", async () => {
  for (const stage of ["approval-dispatched", "purchase-dispatched"]) {
    const { storage, adapter, prepare, pay, controller, data } = fixture();
    storage.setItem.mockImplementation((key, value) => {
      if (JSON.parse(value).stage === stage) throw new Error("QuotaExceededError");
      data.set(key, value);
    });
    await prepare();
    await pay();
    expect(adapter.approve).toHaveBeenCalledTimes(stage === "approval-dispatched" ? 0 : 1);
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(controller.getState().error?.code).toBe("StorageUnavailable");
  }
});

it("corrupt storage blocks new quotes and leaves the original entry for investigation", async () => {
  const { adapter, data, store, make } = fixture();
  store.put(record);
  const key = [...data.keys()][0];
  data.set(key, "{");
  const reloaded = make();
  await reloaded.prepare(30n);
  await reloaded.check();
  expect(adapter.prepare).not.toHaveBeenCalled();
  expect(reloaded.getState()).toMatchObject({ phase: "unresolved", requiredAction: "review", error: { code: "StorageUnavailable" } });
  expect(data.get(key)).toBe("{");
});

it("switching funding sources cannot bypass a lost purchase or expose its reference", async () => {
  const { adapter, store, make } = fixture();
  store.put(record);
  adapter.scope = { ...scope, payer: { provider: "oisy", owner: "2vxsx-fae" } };
  const switched = make();
  await switched.prepare(30n);
  await switched.check();
  expect(switched.getState()).toMatchObject({ phase: "unresolved", error: { code: "AccountChanged" } });
  expect(switched.getState().summary).toBeUndefined();
  expect(switched.getState().reference).toBeUndefined();
  expect(adapter.prepare).not.toHaveBeenCalled();
  expect(adapter.check).not.toHaveBeenCalled();
  expect(adapter.restore).not.toHaveBeenCalled();
});

it("silent recovery checks only at 0, 1, and 3 seconds and stops on invalidation or destroy", async () => {
  vi.useFakeTimers();
  for (const stop of ["never", "signout", "destroy"]) {
    const { adapter, store, make, invalidate } = fixture();
    adapter.capabilities.silentCheck = true;
    store.put(record);
    const reloaded = make();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(adapter.check).toHaveBeenCalledTimes(1);
    if (stop === "signout") invalidate();
    if (stop === "destroy") reloaded.destroy();
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.check).toHaveBeenCalledTimes(stop === "never" ? 2 : 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(adapter.check).toHaveBeenCalledTimes(stop === "never" ? 3 : 1);
    expect(adapter.submit).not.toHaveBeenCalled();
    reloaded.destroy();
  }
});

it("missing Web Locks blocks dispatch but still allows a read-only recovery check", async () => {
  const { adapter, store, make, terms } = fixture();
  const uncoordinated = make(null);
  await uncoordinated.prepare(30n);
  await uncoordinated.pay(terms.termsKey);
  expect(uncoordinated.getState().error?.code).toBe("CoordinationUnavailable");
  expect(adapter.prepare).not.toHaveBeenCalled();
  store.put(record);
  const recovery = make(null);
  await recovery.check();
  expect(adapter.check).toHaveBeenCalledWith(record);
  expect(adapter.submit).not.toHaveBeenCalled();
});

it("the target journal is checked inside the acquired lock before any new quote", async () => {
  const { adapter, make, store } = fixture();
  const contending = make({
    request: async (_key, _options, action) => {
      store.put({ ...record, scope: { ...scope, payer: { owner: "2vxsx-fae", provider: "plug" } } });
      await action({});
    },
  });
  await contending.prepare(30n);
  expect(adapter.prepare).not.toHaveBeenCalled();
  expect(contending.getState()).toMatchObject({ phase: "unresolved", error: { code: "AccountChanged" } });
});

it("a restored confirmed quote cannot dispatch after another tab handles its journal", async () => {
  const { adapter, store, make, terms } = fixture();
  store.put({ ...record, stage: "quote-dispatched" });
  adapter.check.mockResolvedValue({ kind: "unsubmitted", expired: false });
  const contender = make();
  await contender.check();
  expect(contender.getState().phase).toBe("ready");
  store.remove(scope, record.id);
  await contender.pay(terms.termsKey);
  expect(adapter.approve).not.toHaveBeenCalled();
  expect(adapter.submit).not.toHaveBeenCalled();
});

it("a lost quote uses the adapter's preassigned recovery operation instead of preparing another", async () => {
  const { adapter, store, controller, prepare } = fixture();
  adapter.prepare.mockImplementation(async () => {
    store.put({ ...record, stage: "quote-dispatched" });
    throw new Error("reply lost");
  });
  await prepare();
  await prepare();
  expect(adapter.prepare).toHaveBeenCalledTimes(1);
  expect(controller.getState()).toMatchObject({ phase: "unresolved", error: { stage: "preparing" } });
  await controller.check();
  expect(adapter.check).toHaveBeenCalledWith(expect.objectContaining({ stage: "quote-dispatched" }));
});

it("an occupied target lock rejects a competing tab without queuing or invoking its adapter", async () => {
  const { make, adapter } = fixture();
  const occupied = new Set<string>();
  const locks = {
    request: async (key: string, options: { ifAvailable: true }, run: (lock: object | null) => Promise<void>) => {
      expect(options.ifAvailable).toBe(true);
      if (occupied.has(key)) return run(null);
      occupied.add(key);
      try { await run({}); } finally { occupied.delete(key); }
    },
  };
  const first = make(locks);
  const second = make(locks);
  let release!: () => void;
  const prompt = new Promise<void>(resolve => { release = resolve; });
  adapter.approve.mockImplementation(() => prompt);
  await first.prepare(30n);
  await second.prepare(30n);
  const paying = first.pay(first.getState().summary!.termsKey);
  await vi.waitFor(() => expect(adapter.approve).toHaveBeenCalledTimes(1));
  await second.pay(second.getState().summary!.termsKey);
  release();
  await paying;
  expect(adapter.submit).toHaveBeenCalledTimes(1);
  expect(second.getState().error?.code).toBe("Unavailable");
});

it("an approved original operation skips approval after an explicit authoritative recovery check", async () => {
  const { adapter, store, make, terms } = fixture();
  store.put({ ...record, stage: "approved" });
  adapter.check.mockResolvedValue({ kind: "unsubmitted", expired: false });
  const recovery = make();
  await recovery.check();
  expect(recovery.getState().phase).toBe("ready");
  expect(adapter.submit).not.toHaveBeenCalled();
  await recovery.pay(terms.termsKey);
  expect(adapter.approve).not.toHaveBeenCalled();
  expect(adapter.submit).toHaveBeenCalledTimes(1);
});

it("an adapter reporting an invalid recovery context retains the entry for investigation", async () => {
  const { adapter, make, store } = fixture();
  store.put({ ...record, stage: "quote-dispatched" });
  adapter.check.mockRejectedValue({ InvalidReply: null });
  const recovery = make();
  await recovery.check();
  await recovery.prepare(30n);
  expect(recovery.getState()).toMatchObject({ phase: "unresolved", requiredAction: "review", error: { code: "InvalidReply" } });
  expect(store.list(scope)).toHaveLength(1);
  expect(adapter.prepare).not.toHaveBeenCalled();
});

it("a terminal recovery rejection clears only the handled operation", async () => {
  const { adapter, make, store } = fixture();
  store.put(record);
  adapter.check.mockResolvedValue({ kind: "rejected", code: "BadFee" });
  const recovery = make();
  await recovery.check();
  expect(recovery.getState()).toMatchObject({ phase: "failed", error: { stage: "paying", code: "BadFee" } });
  expect(store.list(scope)).toEqual([]);
});

it("a changed payer in a restored snapshot cannot authorize the original payment", async () => {
  const { adapter, make, store, terms } = fixture();
  store.put({ ...record, stage: "quote-dispatched" });
  adapter.check.mockResolvedValue({ kind: "unsubmitted", expired: false });
  adapter.restore.mockResolvedValue({ ...terms, scope: { ...scope, payer: { provider: "plug", owner: "2vxsx-fae" } } });
  const recovery = make();
  await recovery.check();
  await recovery.pay(terms.termsKey);
  expect(recovery.getState()).toMatchObject({ phase: "unresolved", error: { code: "InvalidReply" } });
  expect(adapter.submit).not.toHaveBeenCalled();
});

it("one explicit check can recover a verified approval without reopening its ledger prompt", async () => {
  const { adapter, store, make, terms } = fixture();
  store.put({ ...record, stage: "approval-dispatched" });
  adapter.check.mockImplementation(async saved => {
    store.put({ ...saved, stage: "approved" }); // adapter verified the original approval independently
    return { kind: "unsubmitted", expired: false };
  });
  const recovery = make();
  await recovery.check();
  expect(recovery.getState().phase).toBe("ready");
  expect(adapter.submit).not.toHaveBeenCalled();
  await recovery.pay(terms.termsKey);
  expect(adapter.approve).not.toHaveBeenCalled();
  expect(adapter.submit).toHaveBeenCalledTimes(1);
});

it("an occupied lock during balance refresh cannot replace a completed receipt with payment failure", async () => {
  const { make, terms, adapter } = fixture();
  let occupied = false;
  const controller = make({ request: async (_key, _options, action) => action(occupied ? null : {}) });
  await controller.prepare(30n);
  await controller.pay(terms.termsKey);
  occupied = true;
  await controller.refreshBalance();
  expect(controller.getState()).toMatchObject({ phase: "complete", receipt: paid.receipt, balanceUnavailable: true });
  expect(adapter.submit).toHaveBeenCalledTimes(1);
});

it("a pending status check preserves the allowlisted reason for an uncertain dispatch", async () => {
  const { adapter, prepare, pay, controller } = fixture();
  adapter.submit.mockRejectedValue({ Busy: null });
  await prepare();
  await pay();
  await controller.check();
  expect(controller.getState()).toMatchObject({
    phase: "unresolved", error: { stage: "paying", code: "Unavailable" }, requiredAction: "review",
  });
});

it("scheduled recovery does not start interactive reads when silent access changes during lock acquisition", async () => {
  vi.useFakeTimers();
  const { adapter, store, make } = fixture();
  adapter.capabilities.silentCheck = true;
  store.put(record);
  const recovery = make({ request: async (_key, _options, action) => {
    adapter.capabilities.silentCheck = false;
    await action({});
  } });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(adapter.check).not.toHaveBeenCalled();
  expect(recovery.getState().phase).toBe("unresolved");
  await recovery.check();
  expect(adapter.check).toHaveBeenCalledTimes(1);
  recovery.destroy();
});

it("scheduled recovery does not open an interactive restore after the status read", async () => {
  vi.useFakeTimers();
  const { adapter, store, make } = fixture();
  store.put({ ...record, stage: "quote-dispatched" });
  adapter.capabilities.silentCheck = true;
  adapter.check.mockImplementation(async () => {
    adapter.capabilities.silentCheck = false;
    return { kind: "unsubmitted", expired: false };
  });
  const recovery = make();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(adapter.restore).not.toHaveBeenCalled();
  expect(recovery.getState().phase).toBe("unresolved");
  await recovery.check();
  expect(adapter.restore).toHaveBeenCalledTimes(1);
  recovery.destroy();
});

it("an ambiguous approval cannot be downgraded to a fresh quote by a status read", async () => {
  const { adapter, store, make, terms } = fixture();
  store.put({ ...record, stage: "approval-dispatched" });
  adapter.check.mockImplementation(async saved => {
    store.put({ ...saved, stage: "quote-dispatched" });
    return { kind: "unsubmitted", expired: false };
  });
  const recovery = make();
  await recovery.check();
  await recovery.pay(terms.termsKey);
  expect(adapter.approve).not.toHaveBeenCalled();
  expect(recovery.getState()).toMatchObject({ phase: "unresolved" });
});

it("a definitive approval refusal preserves the original Vault quote for explicit review", async () => {
  const { adapter, prepare, pay, controller, terms, store } = fixture();
  adapter.prepare.mockImplementation(async () => {
    store.put({ ...record, stage: "quote-dispatched" });
    return terms;
  });
  adapter.approve.mockRejectedValue({ ApprovalRejected: null });
  await prepare();
  await pay();
  expect(controller.getState()).toMatchObject({ phase: "failed", error: { stage: "approving", code: "ApprovalRejected" } });
  expect(store.list(scope)[0].stage).toBe("quote-dispatched");
});

it("a silent paid result retains the receipt when refreshing now requires user interaction", async () => {
  vi.useFakeTimers();
  const { adapter, make, store } = fixture();
  adapter.capabilities.silentCheck = true;
  adapter.check.mockImplementation(async () => {
    adapter.capabilities.silentCheck = false;
    return paid;
  });
  store.put(record);
  const recovery = make();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(adapter.refreshCredit).not.toHaveBeenCalled();
  expect(recovery.getState()).toMatchObject({ phase: "complete", receipt: paid.receipt, balanceUnavailable: true });
  await recovery.refreshBalance();
  expect(adapter.refreshCredit).toHaveBeenCalledTimes(1);
  recovery.destroy();
});

it.each([
  ["expired on prepare", "Expired", "preparing", 0],
  ["expired before approval", "Expired", "approving", 0],
  ["changed before approval", "TermsChanged", "approving", 0],
  ["changed after acknowledged approval", "TermsChanged", "paying", 1],
] as const)("journaled quote %s is a definite failure with an explicit review path", async (scenario, code, stage, approvals) => {
  vi.useFakeTimers();
  const { adapter, controller, terms, store, prepare, pay, setTime } = fixture();
  adapter.capabilities.silentCheck = true;
  adapter.prepare.mockImplementation(async () => {
    store.put({ ...record, stage: "quote-dispatched" });
    return scenario === "expired on prepare" ? { ...terms, expiresAtNs: 10n } : terms;
  });
  if (approvals) adapter.revalidate.mockResolvedValueOnce("unchanged");
  adapter.revalidate.mockResolvedValue("changed");
  await prepare();
  if (scenario === "expired before approval") setTime(100n);
  await pay();
  await pay();
  await prepare();
  expect(controller.getState()).toMatchObject({ phase: "failed", error: { stage, code }, requiredAction: "check" });
  expect(store.list(scope)[0].stage).toBe(approvals ? "approved" : "quote-dispatched");
  expect(adapter.approve).toHaveBeenCalledTimes(approvals);
  expect(adapter.submit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(adapter.check).not.toHaveBeenCalled();
  adapter.check.mockResolvedValue({ kind: "unsubmitted", expired: true });
  await controller.check();
  expect(controller.getState().canCancelUnsubmitted).toBe(true);
  await controller.cancelUnsubmitted();
  expect(store.list(scope)).toEqual([]);
  controller.destroy();
});

it.each(["approval", "purchase"] as const)("lost %s after a journaled quote keeps the dispatched marker unresolved", async stage => {
  const { adapter, prepare, pay, controller, store, terms } = fixture();
  adapter.prepare.mockImplementation(async () => {
    store.put({ ...record, stage: "quote-dispatched" });
    return terms;
  });
  if (stage === "approval") adapter.approve.mockRejectedValue(new Error("reply lost"));
  else adapter.submit.mockRejectedValue(new Error("reply lost"));
  await prepare();
  await pay();
  expect(controller.getState()).toMatchObject({ phase: "unresolved", error: { stage: stage === "approval" ? "approving" : "paying" } });
  expect(store.list(scope)[0].stage).toBe(stage === "approval" ? "approval-dispatched" : "purchase-dispatched");
  await controller.cancelUnsubmitted();
  await pay();
  expect(adapter.cancel).not.toHaveBeenCalled();
  expect(adapter.approve).toHaveBeenCalledTimes(1);
  expect(adapter.submit).toHaveBeenCalledTimes(stage === "approval" ? 0 : 1);
});

it.each(["unavailable", "pending"] as const)("a %s status cannot roll back a known receipt while cleanup is retried", async response => {
  const { adapter, store, storage, prepare, pay, controller } = fixture();
  storage.removeItem.mockImplementationOnce(() => { throw new Error("storage disabled"); })
    .mockImplementationOnce(() => { throw new Error("still disabled"); });
  if (response === "unavailable") adapter.check.mockRejectedValue({ Unavailable: null });
  else adapter.check.mockResolvedValue(pending);
  await prepare();
  await pay();
  expect(store.list(scope)[0].stage).toBe("paid");
  expect(controller.getState()).toMatchObject({ phase: "complete", receipt: paid.receipt, balance: 90n });
  await controller.check();
  expect(controller.getState()).toMatchObject({ phase: "complete", receipt: paid.receipt, balance: 90n, error: { code: "StorageUnavailable" } });
  await controller.check();
  expect(controller.getState()).toMatchObject({ phase: "complete", receipt: paid.receipt, balance: 90n });
  expect(controller.getState().error).toBeUndefined();
  expect(store.list(scope)).toEqual([]);
  expect(adapter.check).not.toHaveBeenCalled();
  expect(adapter.submit).toHaveBeenCalledTimes(1);
});

it("cleanup of a known receipt cannot remove a different pending payment", async () => {
  const { adapter, store, storage, prepare, pay, controller } = fixture();
  storage.removeItem.mockImplementationOnce(() => { throw new Error("storage disabled"); });
  await prepare();
  await pay();
  store.remove(scope, "p1");
  store.put({ ...record, id: "other" });
  await controller.check();
  expect(adapter.check).toHaveBeenCalledWith(expect.objectContaining({ id: "other" }));
  expect(store.list(scope)[0].id).toBe("other");
  expect(controller.getState()).toMatchObject({ phase: "unresolved", requiredAction: "review" });
});

it("preparing while paid-journal cleanup is blocked preserves the confirmed receipt", async () => {
  const { adapter, storage, prepare, pay, controller } = fixture();
  storage.removeItem.mockImplementation(() => { throw new Error("storage disabled"); });
  await prepare();
  await pay();
  await prepare();
  expect(controller.getState()).toMatchObject({ phase: "complete", receipt: paid.receipt, error: { code: "StorageUnavailable" } });
  expect(adapter.prepare).toHaveBeenCalledTimes(1);
});

it("invalidation queued across the final revalidation promise prevents dispatch", async () => {
  const { adapter, prepare, pay, invalidate } = fixture();
  adapter.revalidate.mockImplementation(async () => {
    queueMicrotask(() => queueMicrotask(invalidate));
    return "unchanged";
  });
  await prepare();
  await pay();
  expect(adapter.approve).not.toHaveBeenCalled();
  expect(adapter.submit).not.toHaveBeenCalled();
});

it("carries the acknowledged context and independent receipt into the paid-stage write", async () => {
  const { adapter, storage, store, prepare, pay } = fixture();
  const acknowledged = { exactRequest: "p1", verifiedBlock: "15" };
  adapter.submit.mockResolvedValue({ ...paid, acknowledgedContext: acknowledged });
  storage.removeItem.mockImplementationOnce(() => { throw new Error("temporarily read only"); });
  await prepare();
  await pay();
  expect(store.list(scope)[0]).toMatchObject({ stage: "paid", context: {
    acknowledged, receipt: { reference: "block:15", creditedCycles: "50" },
  } });
});

it("checks only the displayed operation after acquiring the status lock", async () => {
  const {store, adapter, make} = fixture();
  store.put(record);
  const controller = make({request: async (_key, _options, run) => {
    store.remove(scope, record.id);
    store.put({...record,id:"another"});
    await run({});
  }});
  await controller.check(record.id);
  expect(adapter.check).not.toHaveBeenCalled();
  expect(store.list(scope)[0].id).toBe("another");
  controller.destroy();
});

it.each(["cleanup","balance"] as const)("recovers combined receipt cleanup and balance failures with %s first",async first=>{
  const {adapter,storage,store,prepare,pay,controller}=fixture();
  storage.removeItem.mockImplementationOnce(()=>{throw Error("read only");});
  adapter.refreshCredit.mockRejectedValueOnce(Error("balance offline"));
  await prepare();await pay();
  expect(controller.getState()).toMatchObject({phase:"complete",receipt:paid.receipt,balanceUnavailable:true,cleanupPending:true});
  if(first==="cleanup"){
    await controller.check();
    expect(controller.getState().cleanupPending).toBeUndefined();
    expect(controller.getState().balanceUnavailable).toBe(true);
    await controller.refreshBalance();
  }else{
    await controller.refreshBalance();
    expect(controller.getState().balanceUnavailable).toBeUndefined();
    expect(controller.getState().cleanupPending).toBe(true);
    await controller.check();
  }
  expect(controller.getState()).toMatchObject({phase:"complete",receipt:paid.receipt,balance:90n});
  expect(controller.getState().error).toBeUndefined();
  expect(controller.getState().cleanupPending).toBeUndefined();
  expect(store.list(scope)).toHaveLength(0);
  expect(adapter.submit).toHaveBeenCalledOnce();
  expect(adapter.check).not.toHaveBeenCalled();
  controller.destroy();
});


it.each(["paid", "expired"] as const)("recovers an exact legacy %s journal while another ledger holds the beneficiary", async outcome => {
  const f = fixture();
  const stage = outcome === "paid" ? "purchase-dispatched" : "quote-dispatched";
  const first = {...record, stage};
  const otherScope = {...scope, ledger:"2vxsx-fae"};
  const other = {...record, scope:otherScope, id:"p2"};
  f.data.set(recoveryTargetKey(scope), JSON.stringify(first));
  f.data.set(recoveryTargetKey(otherScope), JSON.stringify(other));
  expect(f.store.hasTargetConflict(scope)).toBe(true);
  expect(f.store.hasTargetConflict(otherScope)).toBe(true);
  f.adapter.check.mockResolvedValue(outcome === "paid" ? paid : {kind:"unsubmitted", expired:true});
  const c = f.make();
  await c.prepare(30n);
  await c.pay(f.terms.termsKey);
  expect(f.adapter.prepare).not.toHaveBeenCalled();
  expect(f.adapter.approve).not.toHaveBeenCalled();
  expect(f.adapter.submit).not.toHaveBeenCalled();
  await c.check();
  expect(f.adapter.check).toHaveBeenCalledWith(first);
  if (outcome === "expired") {
    expect(c.getState().canCancelUnsubmitted).toBe(true);
    await c.cancelUnsubmitted();
    expect(f.adapter.cancel).toHaveBeenCalledWith(f.terms);
  } else expect(c.getState()).toMatchObject({phase:"complete", receipt:paid.receipt});
  expect(f.store.list(scope)).toEqual([]);
  expect(f.store.list(otherScope)).toEqual([other]);
  expect(f.adapter.approve).not.toHaveBeenCalled();
  expect(f.adapter.submit).not.toHaveBeenCalled();
  c.destroy();
});
