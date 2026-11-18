import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { idlFactory, type FundingConfig, type Payment, type PurchaseRequest } from "@kinic/vault-candid";
import { createRecoveryStore } from "@kinic/payments/recovery-store";
import { createPaymentController } from "@kinic/payments/controller";
import type { ApproveArgs, FundingTransport, WalletCall } from "@kinic/payments/wallet-types";
import { expect, it, vi } from "vitest";
import { createVaultPaymentAdapter } from "./adapter";

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
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); },
  });
  const state = {
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
      if (request.method === "pay_purchase" && state.invalidateBeforePay) state.live = false;
      expect(request.canisterId).toBe(vault.toText());
      if (!request.isCurrent?.()) throw Error("stale dispatch");
      calls.push({method: request.method, owner: owner.toText()});
      const fn = idlFactory({IDL})._fields.find(([name]) => name === request.method)![1];
      const [arg] = IDL.decode(fn.argTypes, request.arg);
      let reply: unknown;
      switch (request.method) {
        case "list_payments": reply = state.payment?.wallet.toText() === owner.toText() ? [state.payment] : []; break;
        case "quote_purchase": {
          const req = arg as unknown as PurchaseRequest;
          const record = JSON.parse([...values.values()][0]);
          expect(record.stage).toBe("quote-dispatched");
          expect(record.id).toBe(Buffer.from(req.operation).toString("hex"));
          state.payment = {
            request: req, wallet: owner, status: { Quoted: null }, config: fundingConfig,
            fee, credits: req.amount_e8s * 10n, memo: new Uint8Array(32).fill(73), created_at_time: now + 9n,
            generation: 1n, sent_at: 0n, attempt: 0n, uncertain: false, preparing: false, reconciliation: [],
          };
          if (state.lostQuote) throw Error("lost quote");
          reply = state.payment;
          break;
        }
        case "payment_status": reply = state.absent || !state.payment ? [] : [state.payment]; break;
        case "pay_purchase":
          expect(arg).toEqual(state.payment!.request.operation);
          state.payment!.status = { Paid: 351n };
          if (state.lostPay) throw Error("lost payment");
          reply = state.payment; break;
        case "cancel_quote": state.payment!.status = { Expired: null }; reply = state.payment; break;
        case "reconcile_purchase":
          state.scan++;
          reply = { payment: state.payment, next: state.scan, end: 2n, scanned: 1n, can_continue: state.scan < 2n };
          break;
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
  const ownerClient = {
    identity, canister: config.canister, session: {capture: () => 7},
    actor: {account_balance: vi.fn(async () => ({ Ok: 351n }))},
  };
  const options = {
    config, fundingConfig, source: provider, beneficiaryIdentity: identity, walletSession, ownerClient, store,
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
  expect(f.calls.every(c => c.owner === wallet.toText())).toBe(true);
  expect(f.calls.filter(c => c.method === "pay_purchase")).toHaveLength(1);
  expect(f.ownerClient.actor.account_balance).toHaveBeenCalledTimes(1);
  c.destroy();
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
  expect(f.calls.filter(c => c.method === "pay_purchase")).toHaveLength(1);
  expect(f.approvals).toHaveLength(1);
  restored.destroy();
});

it("does not treat a matching allowance as proof of a lost approval", async () => {
  const f = fixture(), c = f.control();
  await c.prepare(amount); f.state.lostApproval = true;
  await c.pay(c.getState().summary!.termsKey); await c.check();
  expect(c.getState().phase).toBe("unresolved");
  expect(f.store.list(f.adapter.scope)[0].stage).toBe("approval-dispatched");
  expect(f.calls.filter(x=>x.method==="pay_purchase")).toHaveLength(0);
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
    expect(f.calls.filter(x => x.method === "pay_purchase")).toHaveLength(0);
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
  expect(f.approvals).toHaveLength(0);
  expect(f.calls.filter(x=>x.method==="pay_purchase")).toHaveLength(0);
  c.destroy();
});
