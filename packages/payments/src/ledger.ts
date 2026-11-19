import { configuredLoopback } from "./network";
import { Actor, AnonymousIdentity, HttpAgent } from "@icp-sdk/core/agent";
import type { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { PaymentFailure } from "./errors";

const ledgerQueries: IDL.InterfaceFactory = ({ IDL }) => {
  const account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
  return IDL.Service({
    icrc1_decimals: IDL.Func([], [IDL.Nat8], ["query"]),
    icrc1_fee: IDL.Func([], [IDL.Nat], ["query"]),
    icrc1_balance_of: IDL.Func([account], [IDL.Nat], ["query"]),
    icrc2_allowance: IDL.Func(
      [IDL.Record({ account, spender: account })],
      [IDL.Record({ allowance: IDL.Nat, expires_at: IDL.Opt(IDL.Nat64) })],
      ["query"],
    ),
  });
};

type DefaultAccount = { owner: Principal; subaccount: [] };

interface LedgerQueries {
  icrc1_decimals(): Promise<number>;
  icrc1_fee(): Promise<bigint>;
  icrc1_balance_of(account: DefaultAccount): Promise<bigint>;
  icrc2_allowance(accounts: { account: DefaultAccount; spender: DefaultAccount }): Promise<{
    allowance: bigint;
    expires_at: [] | [bigint];
  }>;
}

export type LedgerTerms = {
  decimals: number;
  feeE8s: bigint;
  balanceE8s: bigint;
  allowanceE8s: bigint;
  allowanceExpiresAtNs: bigint | null;
};

export async function readLedgerTerms({
  host,
  ledger,
  owner,
  spender,
}: {
  host: string;
  ledger: string;
  owner: string;
  spender: string;
}): Promise<LedgerTerms> {
  const agent = HttpAgent.createSync({ host, identity: new AnonymousIdentity() });
  if (configuredLoopback(host)) await agent.fetchRootKey();
  const actor = Actor.createActor<LedgerQueries>(ledgerQueries, {
    agent,
    canisterId: Principal.fromText(ledger),
  });
  const account: DefaultAccount = { owner: Principal.fromText(owner), subaccount: [] };
  const spenderAccount: DefaultAccount = { owner: Principal.fromText(spender), subaccount: [] };
  const [decimals, feeE8s, balanceE8s, allowance] = await Promise.all([
    actor.icrc1_decimals(),
    actor.icrc1_fee(),
    actor.icrc1_balance_of(account),
    actor.icrc2_allowance({ account, spender: spenderAccount }),
  ]);
  if (decimals !== 8) throw new PaymentFailure("InvalidReply");
  return {
    decimals,
    feeE8s,
    balanceE8s,
    allowanceE8s: allowance.allowance,
    allowanceExpiresAtNs: allowance.expires_at[0] ?? null,
  };
}

export function assertLedgerFee(runtimeFeeE8s: bigint, expectedFeeE8s: bigint): void {
  if (runtimeFeeE8s !== expectedFeeE8s) throw new PaymentFailure("BadFee");
}
