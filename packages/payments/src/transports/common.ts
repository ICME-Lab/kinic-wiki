import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import type { Icrc2Did } from "@dfinity/oisy-wallet-signer";
import type { FundingAccount } from "../types";
import { PaymentFailure } from "../errors";
import { WalletFailure, type ApproveArgs, type DispatchGuard, type FundingTransport, type WalletAccess, type WalletActor, type WalletCall, type WalletIssue } from "../wallet-types";

const approveIDL: IDL.InterfaceFactory = ({ IDL }) => {
  const blob = IDL.Opt(IDL.Vec(IDL.Nat8));
  const args = IDL.Record({
    spender: IDL.Record({ owner: IDL.Principal, subaccount: blob }), from_subaccount: blob, amount: IDL.Nat,
    expected_allowance: IDL.Opt(IDL.Nat), fee: IDL.Opt(IDL.Nat), memo: blob,
    created_at_time: IDL.Opt(IDL.Nat64), expires_at: IDL.Opt(IDL.Nat64),
  });
  const error = IDL.Variant({
    AllowanceChanged: IDL.Record({ current_allowance: IDL.Nat }), BadFee: IDL.Record({ expected_fee: IDL.Nat }),
    CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }), Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
    Expired: IDL.Record({ ledger_time: IDL.Nat64 }), GenericError: IDL.Record({ error_code: IDL.Nat, message: IDL.Text }),
    InsufficientFunds: IDL.Record({ balance: IDL.Nat }), TemporarilyUnavailable: IDL.Null, TooOld: IDL.Null,
  });
  return IDL.Service({ icrc2_approve: IDL.Func([args], [IDL.Variant({ Ok: IDL.Nat, Err: error })], []) });
};
export function principal(text: string): string {
  return Principal.fromText(text).toText();
}
export function ownerPrincipal(text: string): string {
  const owner = Principal.fromText(text);
  if (owner.isAnonymous()) throw new WalletFailure("unsupported-account");
  return owner.toText();
}
export function scopeMap(scopes: readonly WalletAccess[]) {
  const map = new Map<string, Set<string>>();
  for (const { canisterId, methods } of scopes) {
    const key = principal(canisterId);
    const allowed = map.get(key) ?? new Set<string>();
    for (const m of methods) allowed.add(m);
    map.set(key, allowed);
  }
  return map;
}
export function includesScopes(current: readonly WalletAccess[], requested: readonly WalletAccess[]) {
  const allowed = scopeMap(current);
  return requested.every(({ canisterId, methods }) => {
    const entry = allowed.get(principal(canisterId));
    return !!entry && methods.every(method => entry.has(method));
  });
}
function methodType(request: Pick<WalletCall, "interfaceFactory" | "method">) {
  const entry = request.interfaceFactory({ IDL })._fields.find(([name]) => name === request.method);
  if (!entry) throw new PaymentFailure("InvalidReply");
  return entry[1];
}
export function checkDispatch(guard: DispatchGuard) {
  if (guard.isCurrent && !guard.isCurrent()) throw new PaymentFailure("AccountChanged");
}
export async function actorReply(actor: WalletActor, request: WalletCall, beforeDispatch: () => void) {
  const fn = methodType(request);
  const args = IDL.decode(fn.argTypes, request.arg);
  beforeDispatch();
  checkDispatch(request);
  const invoke = actor[request.method];
  if (typeof invoke !== "function") throw new PaymentFailure("InvalidReply");
  const result: unknown = await invoke.apply(actor, args);
  const values = fn.retTypes.length === 0 ? [] : fn.retTypes.length === 1 ? [result] : result;
  if (!Array.isArray(values)) throw new PaymentFailure("InvalidReply");
  return IDL.encode(fn.retTypes, values);
}
export { configuredLoopback } from "../network";
export interface Lifetime {
  assertActive(): void;
  invalidate(reason: WalletIssue): void;
}

export type ScopedTransport = FundingTransport & { withScopes(scopes: readonly WalletAccess[]): ScopedTransport };

export function fundingTransport(options: {
  account: FundingAccount; silentCheck: boolean; scopes: readonly WalletAccess[];
  dispatch(request: WalletCall): Promise<Uint8Array>; revalidate(): Promise<void>; disconnect(): Promise<void>;
  holdSigner?(): () => void;
}): ScopedTransport {
  const allowed = scopeMap(options.scopes);
  async function call(input: WalletCall) {
    checkDispatch(input);
    const request = { ...input, arg: Uint8Array.from(input.arg), canisterId: principal(input.canisterId) };
    if (!allowed.get(request.canisterId)?.has(request.method)) throw new WalletFailure("scope-required");
    const fn = methodType(request);
    const query = fn.annotations.some(a => a === "query" || a === "composite_query");
    if ((query ? "query" : "update") !== request.mode) throw new PaymentFailure("InvalidReply");
    try { return await options.dispatch(request); }
    catch (error) {
      if (error instanceof PaymentFailure) throw error;
      throw new PaymentFailure("Unknown");
    }
  }
  return Object.freeze({
    account: Object.freeze({ ...options.account }), silentCheck: options.silentCheck, call,
    revalidate: options.revalidate, disconnect: options.disconnect,
    ...(options.holdSigner ? { holdSigner: options.holdSigner } : {}),
    withScopes: (scopes: readonly WalletAccess[]) => fundingTransport({ ...options, scopes }),
    async approve(ledger: string, args: ApproveArgs, guard?: DispatchGuard) {
      for (const sub of [args.from_subaccount[0], args.spender.subaccount[0]]) {
        if (sub && (sub.length !== 32 || sub.some(byte => byte !== 0))) throw new WalletFailure("unsupported-account");
      }
      const method = "icrc2_approve";
      const fn = methodType({ interfaceFactory: approveIDL, method });
      const bytes = await call({ ...guard, canisterId: ledger, method, mode: "update", arg: IDL.encode(fn.argTypes, [args]), interfaceFactory: approveIDL });
      const [result] = IDL.decode(fn.retTypes, bytes) as [{ Ok: bigint } | { Err: Icrc2Did.ApproveError }];
      if ("Ok" in result) return result.Ok;
      const error = result.Err;
      if ("Duplicate" in error) return error.Duplicate.duplicate_of;
      if ("BadFee" in error) throw new PaymentFailure("BadFee");
      if ("InsufficientFunds" in error) throw new PaymentFailure("InsufficientFunds");
      if ("AllowanceChanged" in error) throw new PaymentFailure("AllowanceChanged");
      if ("Expired" in error || "TooOld" in error) throw new PaymentFailure("Expired");
      // This branch is reachable only for a decoded ledger Err. Transport loss never enters it.
      throw new PaymentFailure("ApprovalRejected");
    },
  });
}
