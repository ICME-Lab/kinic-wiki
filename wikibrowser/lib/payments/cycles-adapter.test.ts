import { throwCanisterError } from "../vfs-client/actor";
import { Principal } from "@icp-sdk/core/principal";
import { createPaymentController, type PaymentLocks } from "@kinic/payments/controller";
import { createRecoveryStore } from "@kinic/payments/recovery-store";
import { createWalletSessionManager } from "@kinic/payments/wallet-session";
import type { RawDatabaseCyclesPendingPurchase } from "../vfs-client/raw-types";
import type { DatabaseCycleEntryPage } from "../types";
import { beforeEach, expect, it, vi } from "vitest";
import { createWikiCyclesPaymentAdapter, wikiPaymentScopes } from "./cycles-adapter";

const canisterId = "aaaaa-aa";
const ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const authIdentity = { getPrincipal: () => Principal.fromText(canisterId), transformRequest: vi.fn() };
const owner = Principal.fromUint8Array(Uint8Array.of(1));
const config = { kinicLedgerCanisterId: ledger, cyclesPerKinic: "200000000",
  billingAuthorityId: canisterId, minUpdateCycles: "1", iapAuthorityId: null,
  topUp: { enabled: false, thresholdCycles: "0", launcherPrincipal: canisterId } };
const host = "https://icp0.io";
beforeEach(() => vi.stubEnv("VITE_KINIC_WIKI_CANISTER_ID", canisterId));

async function setup() {
  const facts = { decimals: 8, feeE8s: 100000n, balanceE8s: 1200000n, allowanceE8s: 0n, allowanceExpiresAtNs: null as bigint | null };
  const billingClient = { config, getConfig: vi.fn(async () => config), ledgerTerms: vi.fn(async () => facts),
    pending: vi.fn(async (): Promise<unknown[]> => []), history: vi.fn(async (): Promise<DatabaseCycleEntryPage> => ({ entries: [], nextCursor: null })),
    credit: vi.fn(async () => 1n) };
  const purchase = vi.fn(async (): Promise<{ Err: string } | { Ok: { block_index: bigint; amount_cycles: bigint; balance_cycles: bigint } }> => ({ Ok: { block_index: 7n, amount_cycles: 2000001n, balance_cycles: 2000001n } }));
  const status = vi.fn(async (): Promise<{ Ok: RawDatabaseCyclesPendingPurchase[] } | { Err: string }> => ({ Ok: [] }));
  const approve = vi.fn(async () => { facts.balanceE8s -= facts.feeE8s; facts.allowanceE8s = 1100000n; return { Ok: 3n }; });
  const plug = { requestConnect: vi.fn(async () => true), isConnected: vi.fn(async () => true), agent: { getPrincipal: async () => owner },
    createActor: vi.fn(async () => ({ icrc2_approve: approve, purchase_database_cycles: purchase, list_database_cycles_pending_purchases: status })) };
  const walletSession = createWalletSessionManager({ origin: "https://wiki.example", host, signerUrl: "https://sign.example", identity: authIdentity,
    transports: { getPlug: () => plug } });
  await walletSession.connect("plug", wikiPaymentScopes(canisterId, ledger));
  let raw: string | null = null;
  const store = createRecoveryStore({ getItem: () => raw, setItem: (_, value) => { raw = value; }, removeItem: () => { raw = null; } });
  const options = { canisterId, databaseId: "db", authIdentity, billingClient, walletSession, store, origin: "https://wiki.example" };
  const adapter = createWikiCyclesPaymentAdapter(options);
  return { adapter, options, facts, store, billingClient, purchase, approve, walletSession, status, plug };
}

it("blocks an existing pending row and rejects a changed runtime fee before approval", async () => {
  const { adapter, billingClient, facts, approve } = await setup();
  billingClient.pending.mockResolvedValueOnce([{}]);
  await expect(adapter.prepare(1000000n)).rejects.toThrow();
  facts.feeE8s = 90000n;
  await expect(adapter.prepare(1000000n)).rejects.toMatchObject({ code: "BadFee" });
  expect(approve).not.toHaveBeenCalled();
});

it.each(["", "sqlite error 1: "])("allows the decoded linked-reader management denials with prefix %s", async prefix => {
  const { adapter, billingClient, store, purchase } = await setup();
  billingClient.pending.mockImplementation(async () => throwCanisterError(prefix + "principal cannot view pending cycle purchases: db"));
  billingClient.history.mockImplementation(async () => throwCanisterError(prefix + "principal lacks required database role: db"));
  const p = await adapter.prepare(1000000n);
  expect(p.context.baseline).toBeNull();
  store.put({ version: 1, stage: "approval-dispatched", scope: p.scope, id: p.id, context: adapter.encode(p) });
  await adapter.approve(p);
  store.put({ version: 1, stage: "approved", scope: p.scope, id: p.id, context: adapter.encode(p) });
  expect(await adapter.revalidate(p)).toBe("unchanged");
  store.put({ version: 1, stage: "purchase-dispatched", scope: p.scope, id: p.id, context: adapter.encode(p) });
  expect(await adapter.submit(p)).toMatchObject({ kind: "paid", receipt: { reference: "7" } });
  expect(purchase).toHaveBeenCalledTimes(1);
});

it("keeps transport failures and decoded denials for a different database closed", async () => {
  const {adapter,billingClient,approve,purchase} = await setup();
  const pending = "principal cannot view pending cycle purchases: db";
  billingClient.pending.mockRejectedValueOnce(new Error(pending));
  await expect(adapter.prepare(1000000n)).rejects.toThrow();
  billingClient.pending.mockImplementationOnce(async()=>throwCanisterError("sqlite error 1: "+pending+"2"));
  await expect(adapter.prepare(1000000n)).rejects.toThrow();
  const history = "sqlite error 1: principal lacks required database role: db";
  billingClient.history.mockRejectedValueOnce(new Error(history));
  await expect(adapter.prepare(1000000n)).rejects.toThrow();
  billingClient.history.mockImplementationOnce(async()=>throwCanisterError(history+" (unavailable)"));
  await expect(adapter.prepare(1000000n)).rejects.toThrow();
  expect(approve).not.toHaveBeenCalled();
  expect(purchase).not.toHaveBeenCalled();
});

it("does not ignore unrelated pending or history read failures", async () => {
  const { adapter, billingClient, approve, purchase } = await setup();
  billingClient.pending.mockRejectedValueOnce(new Error("network unavailable"));
  await expect(adapter.prepare(1000000n)).rejects.toThrow("network unavailable");
  billingClient.history.mockRejectedValueOnce(new Error("network unavailable"));
  await expect(adapter.prepare(1000000n)).rejects.toThrow("network unavailable");
  expect(approve).not.toHaveBeenCalled();
  expect(purchase).not.toHaveBeenCalled();
});

it("funds with an external wallet without requiring Internet Identity", async () => {
  const { options, billingClient, store, purchase } = await setup();
  const adapter = createWikiCyclesPaymentAdapter({ ...options, authIdentity: undefined });
  const p = await adapter.prepare(1000000n);
  store.put({ version: 1, stage: "approval-dispatched", scope: p.scope, id: p.id, context: adapter.encode(p) });
  await adapter.approve(p);
  store.put({ version: 1, stage: "approved", scope: p.scope, id: p.id, context: adapter.encode(p) });
  expect(await adapter.revalidate(p)).toBe("unchanged");
  store.put({ version: 1, stage: "purchase-dispatched", scope: p.scope, id: p.id, context: adapter.encode(p) });
  expect(await adapter.submit(p)).toMatchObject({ kind: "paid" });
  expect(purchase).toHaveBeenCalledTimes(1);
  expect(billingClient.pending).not.toHaveBeenCalled();
  expect(billingClient.history).not.toHaveBeenCalled();
  await expect(adapter.refreshCredit()).rejects.toMatchObject({ code: "Unavailable" });
});

it("bounds an approval and checks only the remaining debit before purchase", async () => {
  const { adapter, store, billingClient, approve, purchase } = await setup();
  const p = await adapter.prepare(1000000n);
  expect(p).toMatchObject({ amountE8s: 1000000n, allowanceE8s: 1100000n, approvalFeeE8s: 100000n, approvalRequired: true });
  store.put({ version: 1, stage: "approval-dispatched", scope: p.scope, id: p.id, context: adapter.encode(p) });
  await adapter.approve(p);
  expect(approve).toHaveBeenCalledWith(expect.objectContaining({ amount: 1100000n, expected_allowance: [0n], fee: [100000n] }));
  store.put({ version: 1, stage: "approved", scope: p.scope, id: p.id, context: adapter.encode(p) });
  expect(await adapter.revalidate(p)).toBe("unchanged");
  store.put({ version: 1, stage: "purchase-dispatched", scope: p.scope, id: p.id, context: adapter.encode(p) });
  expect(await adapter.submit(p)).toMatchObject({ kind: "paid", receipt: { reference: "7", creditedCycles: 2000001n } });
  expect(purchase).toHaveBeenCalledWith({ database_id: "db", payment_amount_e8s: 1000000n, min_expected_cycles: 2000000n });
  expect(billingClient.pending).toHaveBeenCalledWith(canisterId, authIdentity, "db");
});

it("reuses a sufficient allowance and invalidates confirmation on source or database changes", async () => {
  const { adapter, options, facts, approve } = await setup();
  facts.balanceE8s = facts.allowanceE8s = 1100000n;
  const p = await adapter.prepare(1000000n);
  expect(p).toMatchObject({ approvalRequired: false, approvalFeeE8s: 0n });
  const other = createWikiCyclesPaymentAdapter({ ...options, databaseId: "other" });
  expect(await other.revalidate(p)).toBe("changed");
  const ii = createWikiCyclesPaymentAdapter({ ...options, source: "ii" });
  expect(await ii.revalidate(p)).toBe("changed");
  expect(approve).not.toHaveBeenCalled();
});

it("missing_wiki_pending_row_does_not_authorize_repayment", async () => {
  const { adapter, purchase, facts, store, status } = await setup();
  facts.allowanceE8s = 1100000n;
  const p = await adapter.prepare(1000000n);
  const record = { version: 1, stage: "purchase-dispatched", scope: p.scope, id: p.id, context: adapter.encode(p) } as const;
  store.put(record);
  purchase.mockRejectedValueOnce(new Error("timeout"));
  await expect(adapter.submit(p)).rejects.toThrow();
  expect(await adapter.check(record)).toEqual({ kind: "pending", requiredAction: "review" });
  status.mockResolvedValueOnce({ Err: "principal cannot view pending cycle purchases" });
  expect(await adapter.check(record)).toEqual({ kind: "pending", requiredAction: "review" });
  expect(purchase).toHaveBeenCalledTimes(1);
  await expect(adapter.prepare(1000000n)).rejects.toThrow();
});


it("requires the block correlated by the payer reply and the authorized database ledger before crediting", async () => {
  const { adapter, options, facts, purchase, approve, billingClient, store, status } = await setup();
  facts.allowanceE8s = 1100000n;
  const p = await adapter.prepare(1000000n);
  status.mockClear();
  store.put({ version: 1, stage: "purchase-dispatched", scope: p.scope, id: p.id, context: adapter.encode(p) });
  purchase.mockResolvedValueOnce({ Err: "cycles purchase payment completed at ledger block 17 but local cycles application failed; pending operation 9 remains completed for billing authority review: failure" });
  expect(await adapter.submit(p)).toEqual({ kind: "pending", requiredAction: "review", reference:"9" });
  const [record] = store.list(p.scope);
  const entry = { entryId: "12", databaseId: "db", kind: "cycles_purchase", method: "purchase_database_cycles",
    caller: owner.toText(), ledgerBlockIndex: "19", amountCycles: "2000001", paymentAmountE8s: "1000000",
    balanceAfterCycles: "3000000", cyclesPerKinic: null, cyclesDelta: null, createdAtMs: String(Date.now()) };
  billingClient.history.mockResolvedValueOnce({ entries: [entry], nextCursor: null });
  expect(await adapter.check(record)).toEqual({ kind: "pending", requiredAction: "review", reference:"9" });
  billingClient.history.mockRejectedValueOnce(new Error("principal lacks required database role"));
  expect(await adapter.check(record)).toEqual({ kind: "pending", requiredAction: "review", reference:"9" });
  billingClient.history.mockResolvedValueOnce({ entries: [{ ...entry, entryId:"13", ledgerBlockIndex: "17" }], nextCursor: null });
  const receipt = { reference: "17", creditedCycles: 2000001n };
  const original = createPaymentController({ adapter, store, guard: options.walletSession, locks });
  vi.spyOn(store, "remove").mockImplementationOnce(() => { throw new Error("storage unavailable"); });
  try {
    await original.check();
    expect(original.getState()).toMatchObject({ phase: "complete", receipt, error: { stage: "complete" } });
    expect(store.list(p.scope)[0].stage).toBe("paid");
    expect(await adapter.check(store.list(p.scope)[0])).toMatchObject({ kind: "paid", receipt });
  } finally { original.destroy(); adapter.destroy(); }
  const recreated = createWikiCyclesPaymentAdapter(options);
  const reload = createPaymentController({ adapter: recreated, store, guard: options.walletSession, locks });
  try {
    await reload.check();
    expect(reload.getState()).toMatchObject({ phase: "unresolved", requiredAction: "review" });
    expect(reload.getState().receipt).toBeUndefined();
    expect(store.list(p.scope)).toHaveLength(1);
    expect(approve).not.toHaveBeenCalled();
  } finally { reload.destroy(); }

  expect(billingClient.history).toHaveBeenLastCalledWith(canisterId, "db", "12", 100, authIdentity);
  expect(status).toHaveBeenCalledTimes(3);
  expect(purchase).toHaveBeenCalledTimes(1);
  await expect(recreated.check({ ...record, context: { ...record.context as object, amount: "-1" } })).rejects.toMatchObject({ code: "InvalidReply" });
  expect(status).toHaveBeenCalledTimes(3);
});

it("stops a queued wallet dispatch when the route changes", async () => {
  const { options, facts, store, purchase } = await setup();
  let valid = true;
  const adapter = createWikiCyclesPaymentAdapter({ ...options, isCurrent: () => valid });
  facts.allowanceE8s = 1100000n;
  const p = await adapter.prepare(1000000n);
  store.put({ version: 1, stage: "purchase-dispatched", scope: p.scope, id: p.id, context: adapter.encode(p) });
  const dispatched = adapter.submit(p);
  valid = false;
  await expect(dispatched).rejects.toThrow();
  expect(purchase).not.toHaveBeenCalled();
});

const locks: PaymentLocks = { request: async (_name, _options, run) => run({}) };

it("keeps inconsistent approved recovery in review with no payable confirmation", async () => {
  const { options, adapter, purchase, store, status } = await setup();
  const p = await adapter.prepare(1000000n);
  status.mockClear();
  store.put({ version: 1, stage: "approved", scope: p.scope, id: p.id,
    context: { ...adapter.encode(p) as object, dispatchedAtNs: String(Date.now() * 1000000), block: "76", operation: "8" } });
  const recreated = createWikiCyclesPaymentAdapter(options);
  const controller = createPaymentController({ adapter: recreated, store, guard: options.walletSession, locks });
  try {
    await controller.check();
    expect(controller.getState()).toMatchObject({ phase: "unresolved", requiredAction: "review" });
    await controller.pay(p.termsKey);
    expect(store.list(p.scope)).toHaveLength(1);
    expect(purchase).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  } finally { controller.destroy(); }
});

it("cannot adopt a different genuine same-terms credit using imported saga identifiers", async () => {
  const { options, adapter, purchase, store, facts, billingClient } = await setup();
  facts.allowanceE8s = 1100000n;
  const p = await adapter.prepare(1000000n);
  const context = { ...adapter.encode(p) as object, dispatchedAtNs: String(Date.now() * 1000000), operation: "5", block: "91" };
  const r = { version: 1, stage: "purchase-dispatched", id: p.id, scope: p.scope, context } as const;
  store.put(r);
  billingClient.history.mockResolvedValue({ nextCursor: null, entries: [{ entryId: "7", databaseId: "db", kind: "cycles_purchase",
    amountCycles: "2000000", balanceAfterCycles: "2000000", caller: owner.toText(), method: "purchase_database_cycles",
    ledgerBlockIndex: "91", paymentAmountE8s: "1000000", cyclesPerKinic: null, cyclesDelta: null, createdAtMs: String(Date.now()) }] });
  const recreated = createWikiCyclesPaymentAdapter(options);
  expect(await recreated.check(r)).toEqual({ kind: "pending", requiredAction: "review" });
  expect(store.list(p.scope)).toHaveLength(1);
  expect(purchase).not.toHaveBeenCalled();
});

it("requires live acknowledgement before clearing a saved receipt after reload", async () => {
  const { options, facts, purchase, approve, store, status } = await setup();
  facts.allowanceE8s = 1100000n;
  const make = () => createPaymentController({ adapter: createWikiCyclesPaymentAdapter(options), store, guard: options.walletSession, locks });
  const initial = make();
  await initial.prepare(1000000n);
  vi.spyOn(store, "remove").mockImplementationOnce(() => { throw new Error("storage unavailable"); });
  await initial.pay(initial.getState().summary!.termsKey);
  const originalScope = initial.getState().summary!.scope;
  const receipt = { reference: "7", creditedCycles: 2000001n };
  expect(initial.getState()).toMatchObject({ phase: "complete", receipt });
  const [marker] = store.list(originalScope);
  expect(marker.stage).toBe("paid");
  const inconsistent = { ...marker, context: { ...marker.context as object, receipt: { reference: "8", creditedCycles: "2000001" } } };
  expect(await createWikiCyclesPaymentAdapter(options).check(inconsistent)).toEqual({ kind: "pending", requiredAction: "review" });
  // A caller-supplied transplant disagrees with the actual saved envelope.
  const other = {...marker, id:"different-operation"};
  expect(await createWikiCyclesPaymentAdapter(options).check(other)).toEqual({kind:"pending", requiredAction:"review"});
  store.put(inconsistent);
  expect(await createWikiCyclesPaymentAdapter(options).check(store.list(originalScope)[0])).toEqual({kind:"pending", requiredAction:"review"});
  store.put(marker);
  initial.destroy();
  status.mockClear();
  const reload = make();
  try {
    await reload.check();
    expect(reload.getState()).toMatchObject({ phase: "unresolved", requiredAction: "review" });
    expect(reload.getState().receipt).toBeUndefined();
    expect(purchase).toHaveBeenCalledTimes(1);
    expect(approve).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(store.list(originalScope)[0].stage).toBe("paid");
  } finally { reload.destroy(); }

});

it.each([true,false])("checks pending rows as the external payer with management II=%s", async management => {
  const { options, status, approve, purchase, billingClient, store } = await setup();
  const adapter = createWikiCyclesPaymentAdapter({...options,authIdentity:management ? authIdentity : undefined});
  const row: RawDatabaseCyclesPendingPurchase = {operation_id:7n,database_id:"db",status:"pending",
    amount_cycles:2000000n,payment_amount_e8s:1000000n,ledger_block_index:[],created_at_ms:0n,required_action:"review"};
  status.mockResolvedValueOnce({Ok:[row]});
  await expect(adapter.prepare(1000000n)).rejects.toMatchObject({code:"Unavailable"});
  status.mockResolvedValueOnce({Err:"unavailable"});
  await expect(adapter.prepare(1000000n)).rejects.toThrow();
  expect(approve).not.toHaveBeenCalled();
  expect(purchase).not.toHaveBeenCalled();
  if (!management) expect(billingClient.pending).not.toHaveBeenCalled();
  for (const message of [
    "sqlite error 1: principal cannot view pending cycle purchases: other-db",
    "sqlite error 1: principal cannot view pending cycle purchases: db (unavailable)",
    "transport: sqlite error 1: principal cannot view pending cycle purchases: db",
  ]) {
    status.mockResolvedValueOnce({Err:message});
    await expect(adapter.prepare(1000000n)).rejects.toMatchObject({code:"Unavailable"});
  }
  status.mockResolvedValue({Err:(management ? "sqlite error 1: " : "")+"principal cannot view pending cycle purchases: db"});
  const p = await adapter.prepare(1000000n);
  store.put({version:1,id:p.id,scope:p.scope,stage:"approved",context:adapter.encode(p)});
  const r = store.list(p.scope)[0];
  expect(await adapter.check(r)).toMatchObject({kind:"unsubmitted"});
  expect(await adapter.check({...r,stage:"purchase-dispatched"})).toEqual({kind:"pending",requiredAction:"review"});
  status.mockResolvedValueOnce({Err:"denied by service"});
  expect(await adapter.check(r)).toEqual({kind:"pending",requiredAction:"review"});
});


it.each(["approval-dispatched","approved","purchase-dispatched"] as const)("only dismisses an expired acknowledged unsubmitted marker (%s)", async stage => {
  const f = await setup();
  const p = await f.adapter.prepare(1000000n);
  const r = {version:1, id:p.id, scope:p.scope, stage, context:f.adapter.encode(p)} as const;
  f.store.put(r);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Number(p.expiresAtNs! / 1000000n));
  const controller = createPaymentController({adapter:createWikiCyclesPaymentAdapter(f.options), store:f.store, guard:f.walletSession, locks});
  try {
    await controller.check();
    expect(!!controller.getState().canCancelUnsubmitted).toBe(stage === "approved");
    await controller.cancelUnsubmitted();
    expect(f.store.list(p.scope)).toHaveLength(stage === "approved" ? 0 : 1);
    if (stage === "approved") {
      await controller.prepare(1000000n);
      expect(controller.getState().phase).toBe("ready");
    }
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.purchase).not.toHaveBeenCalled();
  } finally { controller.destroy(); clock.mockRestore(); }
});

it.each(["approve","submit"] as const)("does not enter the ledger or service if the queued %s crosses expiry", async method => {
  const f = await setup();
  const p = await f.adapter.prepare(1000000n);
  const put = (stage: "approval-dispatched" | "approved" | "purchase-dispatched") =>
    f.store.put({version:1, id:p.id, scope:p.scope, stage, context:f.adapter.encode(p)});
  put("approval-dispatched");
  if (method === "submit") {
    await f.adapter.approve(p);
    put("approved");
    put("purchase-dispatched");
  }
  const clock = vi.spyOn(Date, "now");
  f.plug.createActor.mockImplementationOnce(async () => {
    clock.mockReturnValue(Number(p.expiresAtNs! / 1000000n));
    return {icrc2_approve:f.approve, purchase_database_cycles:f.purchase, list_database_cycles_pending_purchases:f.status};
  });
  try {
    if (method === "approve") await expect(f.adapter.approve(p)).rejects.toMatchObject({code:"Expired"});
    else expect(await f.adapter.submit(p)).toEqual({kind:"rejected", code:"Expired"});
    expect(f.approve).toHaveBeenCalledTimes(method === "submit" ? 1 : 0);
    expect(f.purchase).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

it.each([
  ["sqlite error 1: cycles purchase quote changed: amount_cycles 1800000 is below min_expected_cycles 2000000", "TermsChanged"],
  ["icrc2_transfer_from failed: InsufficientFunds { balance: Nat(20) }", "InsufficientFunds"],
  ["icrc2_transfer_from failed: TemporarilyUnavailable", "Unavailable"],
  ['icrc2_transfer_from failed: GenericError { error_code: Nat(7), message: "private diagnostic" }', "PaymentRejected"],
  ["icrc2_transfer_from failed: BadBurn { min_burn_amount: Nat(12) }", "PaymentRejected"],
])("recognizes a definitive purchase refusal and permits a new explicit review (%s)", async (message, code) => {
  const f = await setup();
  f.facts.allowanceE8s = 1100000n;
  f.purchase.mockResolvedValueOnce({Err:message});
  const c = createPaymentController({adapter:f.adapter, store:f.store, guard:f.walletSession, locks});
  try {
    await c.prepare(1000000n);
    await c.pay(c.getState().summary!.termsKey);
    expect(c.getState()).toMatchObject({phase:"failed", error:{code}});
    expect(f.store.list(f.adapter.scope)).toEqual([]);
    await c.prepare(1000000n);
    expect(c.getState().phase).toBe("ready");
    expect(f.purchase).toHaveBeenCalledTimes(1);
  } finally { c.destroy(); }
});

it("bounds history reads per action and continues from a validated cursor", async () => {
  const f = await setup();
  let position = 0;
  f.billingClient.history.mockImplementation(async () => {
    if (++position > 12) throw Error("history budget exceeded");
    const entries = Array.from({length:100}, (_, index) => ({
      entryId:String((position-1)*100+index+1), databaseId:"db", kind:"other", amountCycles:"1", balanceAfterCycles:"1",
      method:null, caller:"redacted", ledgerBlockIndex:null, paymentAmountE8s:null, cyclesPerKinic:null, cyclesDelta:null, createdAtMs:"1"
    }));
    return {entries, nextCursor:entries[99].entryId};
  });
  f.facts.allowanceE8s = 1100000n;
  const p = await f.adapter.prepare(1000000n);
  expect(position).toBeLessThanOrEqual(4);
  expect(p.context.baseline).toBe(String(position*100));
  f.store.put({version:1, id:p.id, scope:p.scope, stage:"purchase-dispatched", context:f.adapter.encode(p)});
  f.purchase.mockResolvedValueOnce({Err:"cycles purchase payment completed at ledger block 7 but local cycles application failed; pending operation 2 remains completed for billing authority review: failure"});
  await f.adapter.submit(p);
  for (let action=0; action<2; action++) {
    const start = position;
    expect(await f.adapter.check(f.store.list(p.scope)[0])).toMatchObject({kind:"pending"});
    const calls = f.billingClient.history.mock.calls as unknown as [string,string,string][];
    expect(calls[start][2]).toBe(String(start*100));
    expect(position-start).toBeLessThanOrEqual(4);
  }
  expect(f.purchase).toHaveBeenCalledTimes(1);
});


it("keeps the original dispatch if its response is lost after expiry", async () => {
  const f = await setup();
  f.facts.allowanceE8s = 1100000n;
  f.facts.allowanceExpiresAtNs = BigInt(Date.now()+10000)*1000000n;
  const clock = vi.spyOn(Date, "now");
  f.purchase.mockImplementationOnce(async () => {
    clock.mockReturnValue(Number(f.facts.allowanceExpiresAtNs! / 1000000n));
    throw Error("lost response");
  });
  const c = createPaymentController({adapter:f.adapter, store:f.store, guard:f.walletSession, locks});
  try {
    await c.prepare(1000000n);
    await c.pay(c.getState().summary!.termsKey);
    await c.check();
    expect(c.getState()).toMatchObject({phase:"unresolved"});
    expect(c.getState().canCancelUnsubmitted).toBeUndefined();
    expect(f.store.list(f.adapter.scope)[0].stage).toBe("purchase-dispatched");
    expect(f.purchase).toHaveBeenCalledOnce();
    expect(f.approve).not.toHaveBeenCalled();
  } finally { c.destroy(); clock.mockRestore(); }
});

it("does not confirm a forged persisted paid marker after reload", async () => {
  const { options, facts, store, purchase, approve } = await setup();
  facts.allowanceE8s = 1100000n;
  const initial = createPaymentController({adapter:createWikiCyclesPaymentAdapter(options),store,guard:options.walletSession,locks});
  await initial.prepare(1000000n);
  vi.spyOn(store,"remove").mockImplementationOnce(() => {throw Error("storage unavailable");});
  await initial.pay(initial.getState().summary!.termsKey);
  const [marker] = store.list(initial.getState().summary!.scope);
  const context = marker.context as {acknowledged:{block:string;creditedCycles:string}};
  const forged = {...marker,context:{...marker.context as object,
    acknowledged:{...context.acknowledged,block:"99",creditedCycles:"9000000",balanceAfterCycles:"9000000"},
    receipt:{reference:"99",creditedCycles:"9000000",balanceAfterCycles:"9000000"}}};
  store.remove(marker.scope,marker.id);
  store.put(forged);
  initial.destroy();
  const reload = createPaymentController({adapter:createWikiCyclesPaymentAdapter(options),store,guard:options.walletSession,locks});
  try {
    await reload.check();
    expect(reload.getState()).toMatchObject({phase:"unresolved",requiredAction:"review"});
    expect(reload.getState().receipt).toBeUndefined();
    expect(store.list(marker.scope)).toHaveLength(1);
    expect(purchase).toHaveBeenCalledOnce();
    expect(approve).not.toHaveBeenCalled();
  } finally {reload.destroy();}
});


it.each(["", "sqlite error 1: "])("uses authorized management history after the external payer has no pending rows (%s)", async prefix => {
  const f = await setup();
  f.facts.allowanceE8s = 1100000n;
  const p = await f.adapter.prepare(1000000n);
  f.store.put({version:1, stage:"purchase-dispatched", scope:p.scope, id:p.id, context:f.adapter.encode(p)});
  f.purchase.mockResolvedValueOnce({Err:"cycles purchase payment completed at ledger block 17 but local cycles application failed; pending operation 9 remains completed for billing authority review: failure"});
  await f.adapter.submit(p);
  const record = f.store.list(p.scope)[0];
  const entry = {entryId:"12", databaseId:"db", kind:"cycles_purchase", method:"purchase_database_cycles", caller:owner.toText(), ledgerBlockIndex:"17", amountCycles:"2000001", paymentAmountE8s:"1000000", balanceAfterCycles:"3000000", cyclesPerKinic:null, cyclesDelta:null, createdAtMs:String(Date.now())};
  f.billingClient.history.mockResolvedValue({entries:[entry], nextCursor:null});
  for (const message of ["principal cannot view pending cycle purchases: other-db", "principal cannot view pending cycle purchases: db (unavailable)"]) {
    f.status.mockResolvedValueOnce({Err:prefix+message});
    expect(await f.adapter.check(record)).toMatchObject({kind:"pending"});
  }
  f.status.mockResolvedValueOnce({Err:prefix+"principal cannot view pending cycle purchases: db"});
  expect(await f.adapter.check(record)).toMatchObject({kind:"paid", receipt:{reference:"17", creditedCycles:2000001n, balanceAfterCycles:3000000n}});
  expect(f.purchase).toHaveBeenCalledOnce();
  expect(f.approve).not.toHaveBeenCalled();
});
