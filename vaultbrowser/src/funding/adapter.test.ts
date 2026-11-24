import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { idlFactory, type FundingConfig, type Payment, type PurchaseRequest } from "@kinic/vault-candid";
import { createRecoveryStore } from "@kinic/payments/recovery-store";
import { createPaymentController } from "@kinic/payments/controller";
import type { ApproveArgs, FundingTransport, WalletCall } from "@kinic/payments/wallet-types";
import { expect, it, vi } from "vitest";
import { createVaultPaymentAdapter, listVaultFundingHistory } from "./adapter";

const principal = (byte: number) => Principal.fromUint8Array(new Uint8Array([byte, 1]));
const beneficiary = principal(1), wallet = principal(2), vault = principal(3), ledger = principal(5);
const recipient = principal(6);
const config = {
  canister: vault.toText(), host: "http://localhost:4943", local: true,
  origin: "http://vault.localhost", derivationOrigin: "http://" + vault.toText() + ".localhost",
  identityProvider: "http://id.localhost", fundingMode: "synthetic-test-only" as const,
};
const fundingConfig: FundingConfig = { ledger, recipient, cycles_per_kinic: 1_000_000_000n };
const amount = 100_000_000n, fee = 10n, now = 1_800_000_000_000_000_000n;
function fixture(provider: "ii" | "oisy" | "plug" = "oisy") {
  const values = new Map<string, string>();
  const store = createRecoveryStore({
    get length() {return values.size;}, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
      // The submission marker is durable before the beneficiary dispatches the purchase.
      if (JSON.parse(value)?.stage === "purchase-dispatched") {
        if (state.invalidateBeforePay) state.live = false;
        if (state.expireAtPay) state.time = state.payment!.created_at_time + 300_000_000_000n;
      }
    }, removeItem: key => { values.delete(key); },
  });
  const state = {
    quoteError: null as "Busy" | "QuotaExceeded" | "Unauthorized" | "InvalidInput" | "KeyService" | "Conflict" | "Expired" | "Storage" | null,
    onQuoteError: undefined as (() => void) | undefined, expireAtPay: false, rejectPay: false,
    live: true, owner: beneficiary, time: now, lostQuote: false, absent: false, lostPay: false,
    lostApproval: false, invalidateAtApprove: false, invalidateBeforePay: false, invalidateAfterApprove: false,
    balance: amount + 2n * fee, allowance: 0n, expiry: null as bigint | null,
    fee, decimals: 8, payment: undefined as Payment | undefined, scan: 0n,
  };
  const calls: Array<{method: string; owner: string}> = [];
  const approvals: ApproveArgs[] = [];
  const transport = (source: typeof provider, owner: Principal): FundingTransport => ({
    account: { provider: source, owner: owner.toText() }, silentCheck: source !== "oisy",
    revalidate: async () => {}, disconnect: async () => {},
    async call(request: WalletCall) {
      await Promise.resolve();
      expect(request.canisterId).toBe(vault.toText());
      if (!request.isCurrent?.()) throw Error("stale dispatch");
      calls.push({method: request.method, owner: owner.toText()});
      const fn = idlFactory({IDL})._fields.find(([name]) => name === request.method)![1];
      const [arg] = IDL.decode(fn.argTypes, request.arg);
      let reply: unknown;
      switch (request.method) {
        case "quote_purchase": {
          const req = arg as unknown as PurchaseRequest;
          const record = [...values.values()].map(value => JSON.parse(value))
            .find(record => record.id === Buffer.from(req.operation).toString("hex"));
          expect(record.stage).toBe("quote-dispatched");
          expect(record.id).toBe(Buffer.from(req.operation).toString("hex"));
          if (state.quoteError) {
            state.onQuoteError?.();
            return IDL.encode(fn.retTypes, [{Err: {[state.quoteError]: null}}]);
          }
          state.payment = {
            request: req, wallet: owner, status: { Quoted: null }, config: fundingConfig,
            fee, credits: req.amount_e8s * 10n, memo: new Uint8Array(32).fill(73), created_at_time: now + 9n,
            generation: 1n, sent_at: 0n, attempt: 0n, uncertain: false, preparing: false, reconciliation: [],
          };
          if (state.lostQuote) throw Error("lost quote");
          reply = state.payment;
          break;
        }
        default: throw Error("unexpected method");
      }
      return IDL.encode(fn.retTypes, [{Ok: reply}]);
    },
    async approve(id, args, guard) {
      await Promise.resolve();
      if (state.invalidateAtApprove) state.live = false;
      if (!guard?.isCurrent?.()) throw Error("stale dispatch");
      expect(id).toBe(ledger.toText());
      approvals.push(args); state.allowance = args.amount; state.expiry = args.expires_at[0]!;
      state.balance -= fee;
      if (state.lostApproval) throw Error("lost approval");
      if (state.invalidateAfterApprove) state.owner = principal(8);
      return 98n;
    },
  });
  const external = transport(provider === "plug" ? "plug" : "oisy", wallet), ii = transport("ii", beneficiary);
  const walletSession = {
    capture: () => 1 as unknown as symbol, isCurrent: () => true,
    getIdentityTransport: () => ii,
    getSnapshot: () => ({state: "connected" as const, account: external.account, transport: external, generation: 1}),
    revalidate: vi.fn(async () => external),
  };
  const identity = { getPrincipal: () => state.owner };
  // The beneficiary's own Vault actor. Its caller is the signed-in identity, never the payer.
  const visible = (payer: Principal) => !!state.payment && state.payment.wallet.toText() === payer.toText()
    && state.payment.request.beneficiary.toText() === state.owner.toText();
  async function read<T>(method: string, run: () => T): Promise<{Ok: T}> {
    await Promise.resolve();
    calls.push({method, owner: state.owner.toText()});
    return {Ok: run()};
  }
  const reader = {
    beneficiary_payments: vi.fn((payer: Principal) =>
      read("beneficiary_payments", () => visible(payer) ? [state.payment!] : [])),
    beneficiary_payment_status: vi.fn((payer: Principal, operation: Uint8Array | number[]) =>
      read("beneficiary_payment_status", () => {
        if (!state.absent && state.payment) expect(operation).toEqual(state.payment.request.operation);
        return !state.absent && visible(payer) ? [state.payment!] as [Payment] : [] as [];
      })),
    beneficiary_pay_purchase: vi.fn((payer: Principal, operation: Uint8Array | number[]) =>
      read("beneficiary_pay_purchase", () => {
        expect(visible(payer)).toBe(true);
        expect(operation).toEqual(state.payment!.request.operation);
        state.payment!.status = state.rejectPay ? { Rejected: null } : { Paid: 351n };
        if (state.lostPay) throw Error("lost payment");
        return state.payment!;
      })),
    beneficiary_cancel_quote: vi.fn((payer: Principal, operation: Uint8Array | number[]) =>
      read("beneficiary_cancel_quote", () => {
        expect(visible(payer)).toBe(true);
        expect(operation).toEqual(state.payment!.request.operation);
        state.payment!.status = { Expired: null };
        return state.payment!;
      })),
    beneficiary_reconcile_purchase: vi.fn((payer: Principal, operation: Uint8Array | number[]) =>
      read("beneficiary_reconcile_purchase", () => {
        expect(visible(payer)).toBe(true);
        expect(operation).toEqual(state.payment!.request.operation);
        state.scan++;
        return { payment: state.payment!, next: state.scan, end: 2n, scanned: 1n, can_continue: state.scan < 2n };
      })),
  };
  const ownerClient = {
    identity, canister: config.canister, session: {capture: () => 7},
    actor: {get_funding_config: vi.fn(async (): Promise<{Ok: [] | [FundingConfig]}> => ({Ok:[fundingConfig]})), account_balance: vi.fn(async () => ({ Ok: 351n }))},
  };
  const options = {
    config, fundingConfig, source: provider, beneficiaryIdentity: identity, reader, walletSession, ownerClient, store,
    isCurrent: () => state.live, nowNs: () => state.time, authorizedPlug: external,
    readTerms: vi.fn(async () => ({
      decimals: state.decimals, feeE8s: state.fee, balanceE8s: state.balance,
      allowanceE8s: state.allowance, allowanceExpiresAtNs: state.expiry,
    })),
  };
  const adapter = createVaultPaymentAdapter(options);
  const control = (a = adapter) => createPaymentController({
    adapter: a, store, nowNs: options.nowNs, guard: {capture: () => 1, isCurrent: options.isCurrent},
    locks: { request: async (_name, _opts, run) => {await run({});} },
  });
  return { options, state, adapter, calls, approvals, values, store, control, ownerClient };
}

it.each(["oisy", "plug"] as const)("external_payer_credits_captured_vault_owner (%s)", async source => {
  const f = fixture(source), c = f.control();
  await c.prepare(amount);
  const summary = c.getState().summary!;
  expect(f.state.payment!.request.beneficiary.toText()).toBe(beneficiary.toText());
  expect(summary.allowanceE8s).toBe(amount + fee);
  await c.pay(summary.termsKey);
  expect(c.getState()).toMatchObject({ phase: "complete", balance: 351n, receipt: {reference: "351"} });
  expect(f.approvals).toHaveLength(1);
  expect(f.approvals[0]).toEqual({
    from_subaccount: [], spender: {owner: vault, subaccount: []}, amount: amount + fee,
    expected_allowance: [0n], fee: [fee], memo: [f.state.payment!.memo],
    created_at_time: [now + 9n], expires_at: [now + 9n + 300_000_000_000n],
  });
  // The external wallet signs only the quote and the ledger approval.
  expect(f.calls.filter(c => c.owner === wallet.toText()).map(c => c.method)).toEqual(["quote_purchase"]);
  expect(f.calls.filter(c => c.owner !== wallet.toText()).every(c => c.owner === beneficiary.toText()
    && c.method.startsWith("beneficiary_"))).toBe(true);
  expect(f.calls.filter(c => c.method === "beneficiary_pay_purchase")).toHaveLength(1);
  // The payer session is confirmed only before the quote and before the approval.
  expect(f.options.walletSession.revalidate).toHaveBeenCalledTimes(2);
  expect(f.ownerClient.actor.account_balance).toHaveBeenCalledTimes(1);
  c.destroy();
});

it("requires the exact fresh approval even with an older nonexpiring surplus grant", async () => {
  const f = fixture(), c = f.control();
  f.state.allowance = 11n * amount;
  await c.prepare(amount);
  const p = c.getState().summary!;
  expect(p.approvalRequired).toBe(true);
  expect(p.approvalFeeE8s).toBe(fee);
  await c.pay(p.termsKey);
  expect(f.approvals).toHaveLength(1);
  expect(f.approvals[0]).toMatchObject({amount: amount + fee, expected_allowance: [11n * amount],
    memo: [f.state.payment!.memo], created_at_time: [now + 9n], expires_at: [now + 9n + 300_000_000_000n]});
  expect(c.getState().phase).toBe("complete");
  c.destroy();
});

it.each([false, true])("fences payment when funding is paused after approval=%s", async afterApproval => {
  const f = fixture(), c = f.control();
  await c.prepare(amount);
  const discovery = f.ownerClient.actor.get_funding_config;
  if (afterApproval) discovery.mockResolvedValueOnce({Ok:[fundingConfig]});
  discovery.mockResolvedValue({Ok:[]});
  await c.pay(c.getState().summary!.termsKey);
  expect(f.approvals).toHaveLength(afterApproval ? 1 : 0);
  expect(f.calls.filter(c => c.method === "beneficiary_pay_purchase")).toHaveLength(0);
  const [original] = f.store.list(f.adapter.scope);
  expect(original.stage).toBe(afterApproval ? "approved" : "quote-dispatched");
  expect(await f.adapter.check(original)).toMatchObject({kind:"unsubmitted"});
  c.destroy();
});

it("blocks a different payer and rotated ledger for the same synthetic beneficiary", async () => {
  const f = fixture();
  await f.adapter.prepare(amount);
  const rotated = createVaultPaymentAdapter({...f.options, source:"ii", fundingConfig:{...fundingConfig, ledger: principal(9)}});
  expect(f.store.list(rotated.scope)).toEqual([]);
  expect(f.store.hasTargetConflict(rotated.scope)).toBe(true);
  const unaffected = fixture("plug");
  for (const [key,value] of f.values) unaffected.values.set(key,value);
  unaffected.state.owner = principal(10);
  const independent = createVaultPaymentAdapter(unaffected.options);
  expect(unaffected.store.hasTargetConflict(independent.scope)).toBe(false);
  expect((await independent.prepare(amount)).amountE8s).toBe(amount);
  await expect(rotated.prepare(amount)).rejects.toThrow();
  expect(f.calls.filter(c => c.method === "quote_purchase")).toHaveLength(1);
  expect(f.approvals).toHaveLength(0);
  expect(f.calls.filter(c => c.method === "beneficiary_pay_purchase")).toHaveLength(0);
});

it("recovers only the original operation after a lost quote and lost payment", async () => {
  const f = fixture(), first = f.control();
  f.state.lostQuote = true;
  await first.prepare(amount);
  expect(first.getState().phase).toBe("unresolved");
  first.destroy();
  const c = f.control(createVaultPaymentAdapter(f.options));
  f.state.absent = true;
  await c.check(); await c.prepare(amount);
  expect(c.getState().phase).toBe("unresolved");
  f.state.absent = false;
  await c.check();
  expect(c.getState().phase).toBe("ready");
  f.state.lostPay = true;
  await c.pay(c.getState().summary!.termsKey);
  c.destroy();
  const restored = f.control(createVaultPaymentAdapter(f.options));
  f.state.payment!.status = {Quoted: null};
  await restored.check(); await restored.pay("bad");
  expect(restored.getState().phase).toBe("unresolved");
  f.state.payment!.status = {Paid: 351n};
  await restored.check();
  expect(restored.getState().phase).toBe("complete");
  expect(f.calls.filter(c => c.method === "quote_purchase")).toHaveLength(1);
  expect(f.calls.filter(c => c.method === "beneficiary_pay_purchase")).toHaveLength(1);
  expect(f.approvals).toHaveLength(1);
  restored.destroy();
});

it("does not treat a matching allowance as proof of a lost approval", async () => {
  const f = fixture(), c = f.control();
  await c.prepare(amount); f.state.lostApproval = true;
  await c.pay(c.getState().summary!.termsKey); await c.check();
  expect(c.getState().phase).toBe("unresolved");
  expect(f.store.list(f.adapter.scope)[0].stage).toBe("approval-dispatched");
  expect(f.calls.filter(x=>x.method==="beneficiary_pay_purchase")).toHaveLength(0);
  f.state.payment!.status = {Expired: null};
  await c.check();
  expect(c.getState()).toMatchObject({phase: "failed", error: {code: "Expired"}});
  expect(f.store.list(f.adapter.scope)).toEqual([]);
  c.destroy();
});

it.each(["invalidateAtApprove", "invalidateBeforePay", "invalidateAfterApprove"] as const)(
  "guards queued wallet dispatch and captured beneficiary (%s)", async event => {
    const f = fixture(), c = f.control();
    await c.prepare(amount); f.state[event] = true;
    await c.pay(c.getState().summary!.termsKey);
    expect(f.calls.filter(x => x.method === "beneficiary_pay_purchase")).toHaveLength(0);
    expect(f.approvals).toHaveLength(event === "invalidateAtApprove" ? 0 : 1);
    c.destroy();
  },
);

it.each(["Unknown", "InFlight"] as const)("adopts a server %s operation into a fresh journal", async status => {
  const f = fixture();
  await f.adapter.prepare(amount);
  f.values.clear(); f.state.payment!.status = status === "Unknown" ? {Unknown: null} : {InFlight: null};
  f.state.time += 500_000_000_000n;
  const c = f.control(); await c.prepare(amount * 2n); await c.check();
  expect(c.getState().phase).toBe("unresolved");
  expect(f.store.list(f.adapter.scope)[0].stage).toBe("purchase-dispatched");
  expect(f.calls.filter(x=>x.method==="quote_purchase")).toHaveLength(1);
  const record = f.store.list(f.adapter.scope)[0];
  expect((await f.adapter.scan(record)).next).toBe(1n);
  expect((await createVaultPaymentAdapter(f.options).scan(record)).next).toBe(2n);
  // Ledger scans run in the beneficiary session; the payer only signed the quote.
  expect(f.calls.filter(x => x.owner === wallet.toText()).map(x => x.method)).toEqual(["quote_purchase"]);
  expect(f.calls.filter(x => x.method === "beneficiary_reconcile_purchase")).toHaveLength(2);
  expect(f.adapter.capabilities.silentCheck).toBe(true);
  expect(f.approvals).toHaveLength(0);
  expect(f.calls.filter(x=>x.method==="beneficiary_pay_purchase")).toHaveLength(0);
  c.destroy();
});

it.each(["Busy", "QuotaExceeded", "Unauthorized", "InvalidInput", "KeyService"] as const)("releases a refused %s quote only for a new explicit request", async error => {
  const f = fixture(), c = f.control();
  f.state.quoteError = error;
  await c.prepare(amount);
  const code = error === "InvalidInput" ? "PaymentRejected" : "Unavailable";
  expect(c.getState()).toMatchObject({phase: "failed", error: {stage: "preparing", code}});
  expect(f.store.list(f.adapter.scope)).toEqual([]);
  expect(f.calls.filter(x => x.method === "quote_purchase")).toHaveLength(1);
  f.state.quoteError = null;
  await c.prepare(amount);
  expect(c.getState().phase).toBe("ready");
  expect(f.calls.filter(x => x.method === "quote_purchase")).toHaveLength(2);
  expect(f.approvals).toHaveLength(0);
  c.destroy();
});

it.each(["Conflict", "Expired", "Storage"] as const)("retains the partial operation on ambiguous quote %s", async error => {
  const f = fixture(), c = f.control();
  f.state.quoteError = error;
  await c.prepare(amount);
  const record = f.store.list(f.adapter.scope)[0];
  await c.check(); await c.prepare(amount);
  expect(f.store.list(f.adapter.scope)).toEqual([record]);
  expect(c.getState().phase).toBe("unresolved");
  expect(f.calls.filter(x => x.method === "quote_purchase")).toHaveLength(1);
  c.destroy();
});

it("checks the displayed deadline when the queued purchase is actually dispatched", async () => {
  const f = fixture(), c = f.control();
  await c.prepare(amount);
  f.state.expireAtPay = true;
  await c.pay(c.getState().summary!.termsKey);
  expect(f.approvals).toHaveLength(1);
  expect(f.calls.filter(x => x.method === "beneficiary_pay_purchase")).toHaveLength(0);
  expect(f.store.list(f.adapter.scope)[0].stage).toBe("purchase-dispatched");
  c.destroy();
});

it("keeps a legacy II quote discoverable when a connected external wallet is selected", async () => {
  const f = fixture("oisy");
  const iiOptions = {...f.options, source: "ii" as const};
  const ii = createVaultPaymentAdapter(iiOptions);
  const previous = await ii.prepare(amount);
  f.values.clear(); // legacy quotes predate the local recovery journal
  expect(await listVaultFundingHistory(f.options)).toEqual([]);
  const iiHistory = await listVaultFundingHistory(iiOptions);
  expect(iiHistory.map(p => p.wallet.toText())).toEqual([beneficiary.toText()]);
  const c = f.control(ii);
  await c.prepare(amount); await c.check();
  expect(c.getState()).toMatchObject({phase: "ready", summary: {id: previous.id, scope: {payer: {provider: "ii", owner: beneficiary.toText()}}}});
  await c.pay(c.getState().summary!.termsKey);
  expect(c.getState().phase).toBe("complete");
  expect(f.calls.filter(x => x.method === "quote_purchase")).toEqual([{method: "quote_purchase", owner: beneficiary.toText()}]);
  expect(f.calls.filter(x => x.method === "beneficiary_pay_purchase")).toEqual([{method: "beneficiary_pay_purchase", owner: beneficiary.toText()}]);
  expect(f.approvals).toHaveLength(1);
  c.destroy();
});

it("restores a durable approved quote with only principal and transfer fee remaining", async () => {
  const f = fixture(), first = f.control();
  await first.prepare(amount);
  // Stop after the durable approval acknowledgement and before purchase dispatch.
  f.options.readTerms.mockImplementationOnce(async () => ({
    decimals: 8, feeE8s: fee, balanceE8s: f.state.balance, allowanceE8s: 0n, allowanceExpiresAtNs: null,
  })).mockRejectedValueOnce(Error("balance read interrupted"));
  await first.pay(first.getState().summary!.termsKey);
  const original = f.store.list(f.adapter.scope)[0];
  expect(original.stage).toBe("approved");
  expect(f.state.balance).toBe(amount + fee);
  first.destroy();
  const c = f.control(createVaultPaymentAdapter(f.options));
  await c.check();
  expect(c.getState()).toMatchObject({phase: "ready", summary: {id: original.id, approvalRequired: false}});
  await c.pay(c.getState().summary!.termsKey);
  expect(c.getState().phase).toBe("complete");
  expect(f.calls.filter(x => x.method === "quote_purchase")).toHaveLength(1);
  expect(f.calls.filter(x => x.method === "beneficiary_pay_purchase")).toHaveLength(1);
  expect(f.approvals).toHaveLength(1);
  c.destroy();
});

it("releases an authoritatively expired original quote without approval", async () => {
  const f = fixture(), quote = await f.adapter.prepare(amount);
  f.state.payment!.status = {Expired: null};
  const c = f.control(createVaultPaymentAdapter(f.options));
  await c.check(); await c.pay(quote.termsKey);
  expect(c.getState()).toMatchObject({phase: "failed", error: {code: "Expired"}});
  expect(f.store.list(f.adapter.scope)).toEqual([]);
  expect(f.approvals).toEqual([]);
  expect(f.calls.filter(x => x.method === "beneficiary_pay_purchase")).toHaveLength(0);
  c.destroy();
});

it.each(["partial", "full"] as const)("rejects a malformed %s journal before any wallet read", async kind => {
  const f = fixture();
  await f.adapter.prepare(amount);
  const [key, raw] = [...f.values][0];
  const saved = JSON.parse(raw);
  if (kind === "partial") {
    saved.context.quote = null;
    saved.context.request.operation = "ff";
  } else saved.context.quote.extra = "unknown field";
  const malformed = JSON.stringify(saved);
  f.values.set(key, malformed);
  f.calls.length = 0;
  f.options.readTerms.mockClear();
  const c = f.control();
  await c.check();
  expect(c.getState().error?.code).toBe("InvalidReply");
  expect(f.calls).toEqual([]);
  expect(f.options.readTerms).not.toHaveBeenCalled();
  expect(f.values.get(key)).toBe(malformed);
  c.destroy();
});

it("checks historical payments with no active funding configuration", async () => {
  const f = fixture(), original = await f.adapter.prepare(amount);
  const options = {...f.options, fundingConfig: null, recoveryLedger: ledger.toText(),
    config: {...config, fundingMode: "unavailable" as const}};
  const history = await listVaultFundingHistory(options);
  const a = createVaultPaymentAdapter(options), r = a.recordFor(history[0]);
  expect(a.fundingEnabled).toBe(false);
  expect(r.id).toBe(original.id);
  expect(await a.check(r)).toEqual({kind: "unsubmitted", expired: false});
  await expect(a.prepare(amount)).rejects.toMatchObject({code: "Unavailable"});
  await expect(a.revalidate(original)).rejects.toMatchObject({code: "Unavailable"});
  expect(f.calls.filter(x => x.method === "quote_purchase")).toHaveLength(1);
  expect(f.approvals).toHaveLength(0);
  expect(f.calls.filter(x => x.method === "beneficiary_pay_purchase")).toHaveLength(0);
});

it("disables synthetic funding on the production host with a pinned ledger", async () => {
  const f = fixture();
  const remote = {...config, local: false, origin: "https://vault.kinic.xyz", host: "https://icp0.io",
    identityProvider: "https://id.ai", derivationOrigin: "https://" + vault.toText() + ".icp0.io"};
  const a = createVaultPaymentAdapter({...f.options, config: remote,
    fundingConfig: {...fundingConfig, ledger: Principal.fromText("73mez-iiaaa-aaaaq-aaasq-cai")}});
  expect(a.fundingEnabled).toBe(false);
  await expect(a.prepare(amount)).rejects.toMatchObject({code: "Unavailable"});
  expect(f.calls).toEqual([]);
  expect(f.approvals).toEqual([]);
});

it("requires a user-authorized Plug grant for a restored connection", async () => {
  const f = fixture("plug"), restored = {...f.options, authorizedPlug: null};
  expect(() => createVaultPaymentAdapter(restored)).toThrow("Unavailable");
  await expect(listVaultFundingHistory(restored)).rejects.toMatchObject({code: "Unavailable"});
  expect(f.options.walletSession.revalidate).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});

it.each([["fee", "BadFee"], ["decimals", "InvalidReply"], ["allowance", "TermsChanged"]] as const)(
  "checks changed runtime %s before approval", async (change, code) => {
    const f = fixture(), c = f.control();
    await c.prepare(amount);
    if (change === "fee") f.state.fee++;
    if (change === "decimals") f.state.decimals = 7;
    if (change === "allowance") f.state.allowance++;
    await c.pay(c.getState().summary!.termsKey);
    expect(c.getState()).toMatchObject({phase: "failed", error: {code}});
    expect(f.approvals).toEqual([]);
    expect(f.calls.filter(x => x.method === "beneficiary_pay_purchase")).toHaveLength(0);
    c.destroy();
  },
);

it("reports definitive purchase rejection and clears the settled record", async () => {
  const f = fixture(), c = f.control();
  await c.prepare(amount);
  f.state.rejectPay = true;
  await c.pay(c.getState().summary!.termsKey);
  expect(c.getState()).toMatchObject({phase: "failed", error: {code: "PaymentRejected"}});
  expect(f.store.list(f.adapter.scope)).toEqual([]);
  c.destroy();
});

it("preserves a modified partial request if a refusal arrives for its predecessor", async () => {
  const f = fixture(), c = f.control();
  f.state.quoteError = "Busy";
  f.state.onQuoteError = () => {
    const [key, raw] = [...f.values][0];
    const slot = JSON.parse(raw);
    slot.context.request.amount_e8s = (amount + 1n).toString();
    f.values.set(key, JSON.stringify(slot));
  };
  await c.prepare(amount);
  expect(c.getState().phase).toBe("unresolved");
  expect(f.store.list(f.adapter.scope)[0].context).toMatchObject({
    quote: null, request: {amount_e8s: (amount + 1n).toString()},
  });
  expect(f.calls.filter(x => x.method === "quote_purchase")).toHaveLength(1);
  expect(f.approvals).toEqual([]);
  c.destroy();
});

it("cancels an external payer's unpaid quote in the beneficiary session", async () => {
  const f = fixture("oisy");
  const prepared = await f.adapter.prepare(amount);
  await f.adapter.cancel!(prepared);
  expect(f.state.payment!.status).toEqual({Expired: null});
  expect(f.calls.filter(x => x.method === "beneficiary_cancel_quote")).toEqual([
    {method: "beneficiary_cancel_quote", owner: beneficiary.toText()},
  ]);
  expect(f.calls.filter(x => x.owner === wallet.toText()).map(x => x.method)).toEqual(["quote_purchase"]);
});
