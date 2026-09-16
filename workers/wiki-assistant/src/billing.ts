import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import {
  restoreIiKey,
  type IiKeyJson,
} from "@kinic/ii-server/internet-identity";
import { AssistantError } from "./contracts";
import type { Env } from "./env";
type Result<T> = { Ok: T } | { Err: string };
export type Rate = {
  version: bigint;
  cycles_per_minute: bigint;
  authority: string;
};
export type Reservation = {
  session_id: string;
  database_id: string;
  principal: string;
  rate_version: bigint;
  cycles_per_minute: bigint;
  usage_day: bigint;
  created_at_ms: bigint;
  expires_at_ms: bigint;
  reserved_seconds: bigint;
  confirmed_seconds: bigint;
  held_cycles: bigint;
  charged_cycles: bigint;
  closed: boolean;
};
type BillingActor = {
  get_voice_reservation(id: string): Promise<Result<Reservation[]>>;
  get_voice_rate(): Promise<Result<Rate>>;
  get_voice_policy(
    db: string,
    principal: string,
  ): Promise<Result<{ enabled: boolean; daily_budget_cycles: bigint }>>;
  reserve_voice(input: {
    session_id: string;
    database_id: string;
    principal: string;
    rate_version: bigint;
    reserved_seconds: bigint;
  }): Promise<Result<Reservation>>;
  settle_voice(input: {
    session_id: string;
    confirmed_seconds: bigint;
    close: boolean;
  }): Promise<Result<Reservation>>;
};
const factory: Parameters<typeof Actor.createActor>[0] = ({ IDL: i }) => {
  const Rate = i.Record({
    version: i.Nat64,
    cycles_per_minute: i.Nat64,
    authority: i.Text,
  });
  const R = i.Record({
    session_id: i.Text,
    database_id: i.Text,
    principal: i.Text,
    rate_version: i.Nat64,
    cycles_per_minute: i.Nat64,
    usage_day: i.Int64,
    created_at_ms: i.Int64,
    expires_at_ms: i.Int64,
    reserved_seconds: i.Nat64,
    confirmed_seconds: i.Nat64,
    held_cycles: i.Nat64,
    charged_cycles: i.Nat64,
    closed: i.Bool,
  });
  const result = (t: Parameters<typeof i.Opt>[0]) =>
    i.Variant({ Ok: t, Err: i.Text });
  return i.Service({
    get_voice_reservation: i.Func([i.Text], [result(i.Opt(R))], ["query"]),
    get_voice_rate: i.Func([], [result(Rate)], ["query"]),
    get_voice_policy: i.Func(
      [i.Text, i.Text],
      [result(i.Record({ enabled: i.Bool, daily_budget_cycles: i.Nat64 }))],
      ["query"],
    ),
    reserve_voice: i.Func(
      [
        i.Record({
          session_id: i.Text,
          database_id: i.Text,
          principal: i.Text,
          rate_version: i.Nat64,
          reserved_seconds: i.Nat64,
        }),
      ],
      [result(R)],
      [],
    ),
    settle_voice: i.Func(
      [
        i.Record({
          session_id: i.Text,
          confirmed_seconds: i.Nat64,
          close: i.Bool,
        }),
      ],
      [result(R)],
      [],
    ),
  });
};
function actor(
  env: Env,
  identity?: Identity,
  signal?: AbortSignal,
): BillingActor {
  return Actor.createActor<BillingActor>(factory, {
    canisterId: env.KINIC_WIKI_CANISTER_ID,
    agent: HttpAgent.createSync({
      host: "https://icp0.io",
      identity,
      fetch: (input, init) => fetch(input, { ...init, signal }),
    }),
  });
}
function unwrap<T>(r: Result<T>): T {
  if ("Err" in r) {
    const codes: Record<string, string> = {
      "voice permission required": "voice_permission_required",
      "voice daily budget exceeded": "voice_budget_exhausted",
      "insufficient database cycles": "voice_balance_insufficient",
      "voice rate or reservation changed": "voice_price_consent_required",
      "voice billing not configured": "voice_billing_not_configured",
    };
    throw new AssistantError(codes[r.Err] ?? "voice_billing_denied", 403);
  }
  return r.Ok;
}
export async function voicePolicy(
  env: Env,
  identity: Identity,
  db: string,
  principal: string,
) {
  const p = unwrap(await actor(env, identity).get_voice_policy(db, principal));
  if (!p.enabled) throw new AssistantError("voice_permission_required", 403);
  return p;
}
export async function voiceRate(env: Env) {
  return unwrap(await actor(env).get_voice_rate());
}
// Bound the complete update (including replica polling), so an outage cannot
// occupy the alarm through the next funded deadline. Retries use the same ID.
async function billingCall<T>(
  env: Env,
  action: (actor: BillingActor) => Promise<T>,
): Promise<T> {
  if (!env.ASSISTANT_BILLING_KEY)
    throw new AssistantError("voice_billing_not_configured", 503);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AssistantError("voice_billing_unavailable", 503));
    }, 8000);
  });
  try {
    const identity = restoreIiKey(
      JSON.parse(env.ASSISTANT_BILLING_KEY) as IiKeyJson,
    );
    return await Promise.race([
      action(actor(env, identity, controller.signal)),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function reserveVoice(
  env: Env,
  id: string,
  db: string,
  principal: string,
  rate: string,
  seconds: number,
) {
  return unwrap(
    await billingCall(env, (actor) =>
      actor.reserve_voice({
        session_id: id,
        database_id: db,
        principal,
        rate_version: BigInt(rate),
        reserved_seconds: BigInt(seconds),
      }),
    ),
  );
}
export async function settleVoiceCharge(
  env: Env,
  id: string,
  seconds: number,
  close: boolean,
) {
  return unwrap(
    await billingCall(env, (actor) =>
      actor.settle_voice({
        session_id: id,
        confirmed_seconds: BigInt(seconds),
        close,
      }),
    ),
  );
}

export async function voiceReservation(env: Env, id: string) {
  return (
    unwrap(
      await billingCall(env, (actor) => actor.get_voice_reservation(id)),
    )[0] ?? null
  );
}
