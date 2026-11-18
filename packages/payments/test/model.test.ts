import { AnonymousIdentity, Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { afterEach, expect, it, vi } from "vitest";
import { formatKinicExact, parseKinic, totalDebit } from "../src/amounts";
import { classifyPaymentFailure, formatPaymentFailure } from "../src/errors";
import { assertLedgerFee, readLedgerTerms } from "../src/ledger";
import { freezeTerms } from "../src/terms";
import type { PaymentScope, PreparedPayment } from "../src/types";

const ledger = Principal.fromUint8Array(Uint8Array.of(1)).toText();
const owner = Principal.fromUint8Array(Uint8Array.of(2)).toText();
const spender = Principal.fromUint8Array(Uint8Array.of(3)).toText();
const beneficiary = Principal.fromUint8Array(Uint8Array.of(4)).toText();
const recipient = Principal.fromUint8Array(Uint8Array.of(5)).toText();
const scope: PaymentScope = {
  origin: "https://vault.example",
  host: "https://icp0.io",
  ledger,
  spender,
  payer: { provider: "ii", owner },
  target: { kind: "vault", beneficiary },
};
const terms: Omit<PreparedPayment<{ operation: string }>, "termsKey"> = {
  id: "payment-1",
  scope,
  context: { operation: "a12f" },
  recipient,
  amountE8s: 100_000_000n,
  transferFeeE8s: 10n,
  approvalFeeE8s: 10n,
  allowanceE8s: 0n,
  approvalRequired: true,
  credits: 150_000n,
  expiresAtNs: 1_000_000_000_000_000_001n,
};

afterEach(() => vi.restoreAllMocks());

it("exact_total_includes_both_fees", () => {
  const prepared = freezeTerms(terms, "a12f");
  expect(totalDebit(prepared)).toBe(100000020n);
});

it("charges only the transfer fee when an existing allowance is usable", () => {
  const prepared = freezeTerms({ ...terms, approvalRequired: false }, "a12f");
  expect(totalDebit(prepared)).toBe(100_000_010n);
});

it("preserves the smallest units in decimal amounts", () => {
  expect(parseKinic("1.00000001")).toBe(100000001n);
  expect(formatKinicExact(10n)).toBe("0.0000001");
  expect(formatKinicExact(9_007_199_254_740_993n)).toBe("90071992.54740993");
});

it.each(["1.000000001", "-1", "0", "0.00000000", "1e2", "1\n"])(
  "rejects a nonpayable or invalid amount %j",
  (amount) => expect(() => parseKinic(amount)).toThrow(),
);

it("normalizes endpoint URLs and captures scope separately from mutable input", () => {
  const payer: PaymentScope["payer"] = { provider: "ii", owner };
  const original: PaymentScope = {
    ...scope,
    origin: "HTTPS://VAULT.EXAMPLE:443/",
    host: "https://ICP0.IO/",
    payer,
  };
  const prepared = freezeTerms({ ...terms, scope: original }, "a12f");
  payer.owner = beneficiary;
  expect(prepared.scope.payer.owner).toBe(owner);
  expect(prepared.scope.origin).toBe("https://vault.example");
  expect(prepared.scope.host).toBe("https://icp0.io");
  expect(prepared.termsKey).toBe(freezeTerms(terms, "a12f").termsKey);
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(prepared.scope.payer)).toBe(true);
});

it.each([
  ["payer", { scope: { ...scope, payer: { provider: "ii", owner: beneficiary } } }],
  ["provider", { scope: { ...scope, payer: { provider: "plug", owner } } }],
  ["beneficiary", { scope: { ...scope, target: { kind: "vault", beneficiary: owner } } }],
  ["recipient", { recipient: owner }],
  ["transfer fee", { transferFeeE8s: 11n }],
  ["approval fee", { approvalFeeE8s: 11n }],
  ["allowance", { allowanceE8s: 10n }],
  ["approval requirement", { approvalRequired: false }],
  ["expiry", { expiresAtNs: 1_000_000_000_000_000_002n }],
] satisfies [string, Partial<typeof terms>][])("changes the confirmation when %s changes", (_, patch) => {
  expect(freezeTerms({ ...terms, ...patch }, "a12f").termsKey).not.toBe(freezeTerms(terms, "a12f").termsKey);
});

it("binds Wiki confirmations to a specific database and operation", () => {
  const wikiTerms = (databaseId: string, contextKey: string) =>
    freezeTerms({ ...terms, scope: { ...scope, target: { kind: "wiki", databaseId } } }, contextKey).termsKey;
  expect(wikiTerms("abc", "a12f")).not.toBe(wikiTerms("xyz", "a12f"));
  expect(wikiTerms("abc", "a12f")).not.toBe(wikiTerms("abc", "b14e"));
});

it("uses allowlisted error variants without copying nested server messages", () => {
  expect(classifyPaymentFailure("paying", { Expired: null })).toEqual({ stage: "paying", code: "Expired" });
  expect(classifyPaymentFailure("approving", { AllowanceChanged: { current_allowance: 5n } }))
    .toEqual({ stage: "approving", code: "AllowanceChanged" });
  expect(classifyPaymentFailure("paying", { GenericError: { message: "private payload", error_code: 1n } }))
    .toEqual({ stage: "paying", code: "Unknown" });
  expect(classifyPaymentFailure("paying", new Error("Expired")))
    .toEqual({ stage: "paying", code: "Unknown" });
});

function ledgerFixture(decimals: number, expiration: [] | [bigint] = []) {
  const agent = {
    isLocal: vi.fn(() => true),
    fetchRootKey: vi.fn(async () => new ArrayBuffer(0)),
  };
  const actor = {
    icrc1_decimals: vi.fn(async () => decimals),
    icrc1_fee: vi.fn(async () => 10n),
    icrc1_balance_of: vi.fn(async () => 100_000_020n),
    icrc2_allowance: vi.fn(async () => ({ allowance: 19n, expires_at: expiration })),
  };
  const createAgent = vi.spyOn(HttpAgent, "createSync").mockReturnValue(agent as unknown as HttpAgent);
  const createActor = vi.spyOn(Actor, "createActor")
    .mockReturnValue(actor as unknown as ReturnType<typeof Actor.createActor>);
  return { agent, actor, createAgent, createActor };
}

const query = { host: "http://localhost:4943", owner, ledger, spender };

it.each([
  [[], null],
  [[999_000n], 999_000n],
] satisfies [([] | [bigint]), bigint | null][])(
  "reads exact public terms for default payer and spender accounts",
  async (expiresAt, expectedExpiry) => {
    const { agent, actor, createAgent, createActor } = ledgerFixture(8, expiresAt);
    expect(await readLedgerTerms(query)).toEqual({
      decimals: 8,
      feeE8s: 10n,
      balanceE8s: 100_000_020n,
      allowanceE8s: 19n,
      allowanceExpiresAtNs: expectedExpiry,
    });
    expect(createAgent).toHaveBeenCalledWith({ host: query.host, identity: expect.any(AnonymousIdentity) });
    expect(agent.fetchRootKey).toHaveBeenCalledTimes(1);
    expect(createActor).toHaveBeenCalledWith(expect.any(Function), {
      agent,
      canisterId: Principal.fromText(ledger),
    });
    const account = { owner: Principal.fromText(owner), subaccount: [] };
    expect(actor.icrc1_balance_of).toHaveBeenCalledWith(account);
    expect(actor.icrc2_allowance).toHaveBeenCalledWith({
      account,
      spender: { owner: Principal.fromText(spender), subaccount: [] },
    });
  },
);

it("rejects non-KINIC decimals", async () => {
  ledgerFixture(6);
  await expect(readLedgerTerms(query)).rejects.toMatchObject({ code: "InvalidReply" });
});

it("rejects a runtime fee incompatible with Wiki's fixed server fee", async () => {
  ledgerFixture(8);
  const live = await readLedgerTerms(query);
  expect(() => assertLedgerFee(live.feeE8s, 100_000n)).toThrow(expect.objectContaining({ code: "BadFee" }));
  expect(() => assertLedgerFee(live.feeE8s, 10n)).not.toThrow();
});

it("formats a confirmed payment refusal with a fixed message", () => {
  expect(formatPaymentFailure({stage: "paying", code: "PaymentRejected"}))
    .toBe("Payment failed. The service rejected the payment.");
});
