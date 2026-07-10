// Where: workers/payment/src/vfs.ts
// What: Minimal authenticated VFS client for IAP cycle grants.
// Why: The Payment Worker should only expose the one authority operation it needs.

import { identityFromPem } from "./identity-pem.js";
import type { RuntimeEnv } from "./env.js";

export type IapGrantRequest = {
  databaseId: string;
  amountCycles: bigint;
  externalPaymentId: string;
  provider: "apple_iap";
  productId: string;
  purchaserPrincipal: string;
};

export type CyclesPurchaseResult = {
  blockIndex: string;
  amountCycles: string;
  balanceCycles: string;
};

type RawIapGrantRequest = {
  database_id: string;
  amount_cycles: bigint;
  external_payment_id: string;
  provider: string;
  product_id: string;
  purchaser_principal: string;
};

type RawCyclesPurchaseResult = {
  block_index: bigint;
  amount_cycles: bigint;
  balance_cycles: bigint;
};

type VfsActor = {
  grant_database_cycles_from_iap: (request: RawIapGrantRequest) => Promise<{ Ok: RawCyclesPurchaseResult } | { Err: string }>;
};

export async function grantDatabaseCyclesFromIap(env: RuntimeEnv, request: IapGrantRequest): Promise<CyclesPurchaseResult> {
  const [{ Actor, HttpAgent }, { Principal }, identity] = await Promise.all([
    import("@icp-sdk/core/agent"),
    import("@icp-sdk/core/principal"),
    identityFromPem(env.KINIC_IAP_AUTHORITY_IDENTITY_PEM)
  ]);
  const idlFactory: Parameters<typeof Actor.createActor>[0] = ({ IDL: idl }) => {
    const DatabaseCyclesIapGrantRequest = idl.Record({
      database_id: idl.Text,
      amount_cycles: idl.Nat64,
      external_payment_id: idl.Text,
      provider: idl.Text,
      product_id: idl.Text,
      purchaser_principal: idl.Text
    });
    const CyclesPurchaseResult = idl.Record({
      block_index: idl.Nat64,
      amount_cycles: idl.Nat64,
      balance_cycles: idl.Nat64
    });
    return idl.Service({
      grant_database_cycles_from_iap: idl.Func(
        [DatabaseCyclesIapGrantRequest],
        [idl.Variant({ Ok: CyclesPurchaseResult, Err: idl.Text })],
        []
      )
    });
  };
  const agent = HttpAgent.createSync({ host: env.KINIC_WIKI_IC_HOST ?? "https://icp0.io", identity });
  const actor = Actor.createActor<VfsActor>(idlFactory, {
    agent,
    canisterId: Principal.fromText(env.KINIC_WIKI_CANISTER_ID)
  });
  const result = await actor.grant_database_cycles_from_iap({
    database_id: request.databaseId,
    amount_cycles: request.amountCycles,
    external_payment_id: request.externalPaymentId,
    provider: request.provider,
    product_id: request.productId,
    purchaser_principal: request.purchaserPrincipal
  });
  if ("Err" in result) {
    throw new Error(result.Err);
  }
  return {
    blockIndex: result.Ok.block_index.toString(),
    amountCycles: result.Ok.amount_cycles.toString(),
    balanceCycles: result.Ok.balance_cycles.toString()
  };
}
