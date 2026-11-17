// Test-only, served exclusively by owned Playwright interception. No production import.
// AuthClient uses the actual II-issued delegation; all actors and crypto are real.
import { AuthClient } from "@icp-sdk/auth/client";
import { Actor, HttpAgent, AnonymousIdentity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { VaultClient } from "@kinic/vault-client";
import { TransportSecretKey } from "@kinic/vault-crypto";
import type { VaultActor } from "@kinic/vault-client/contracts";
import { idlFactory } from "../../packages/vault-candid/index.js";
const publicValue = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Principal) return value.toText();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, publicValue(v)]),
    );
  return value;
};
async function connect(canister: string, host: string, anonymous = false) {
  if (!new URL(host).hostname.endsWith(".localhost"))
    throw Error("LocalFixtureOnly");
  const auth = await AuthClient.create({ idleOptions: { disableIdle: true } });
  if (!anonymous && !(await auth.isAuthenticated()))
    throw Error("ActualIIAuthenticationRequired");
  const identity = anonymous ? new AnonymousIdentity() : auth.getIdentity();
  const agent = await HttpAgent.create({
    host,
    identity,
    shouldFetchRootKey: true,
  });
  const actor = Actor.createActor<VaultActor>(idlFactory, {
    agent,
    canisterId: canister,
  });
  return { auth, identity, actor };
}
export async function readback(canister: string, host: string) {
  const { identity, actor } = await connect(canister, host);
  const [headers, balance, capacity, payments, uploads] = await Promise.all([
    actor.list_vaults(),
    actor.account_balance(),
    actor.global_capacity(),
    actor.list_payments(),
    actor.list_pending_uploads([]),
  ]);
  return publicValue({
    principal: identity.getPrincipal(),
    headers,
    balance,
    capacity,
    payments,
    uploads,
  });
}
export async function deny(
  canister: string,
  host: string,
  vault: number[],
  object: number[],
  anonymous = false,
) {
  const { identity, actor } = await connect(canister, host, anonymous);
  const random = () => crypto.getRandomValues(new Uint8Array(16));
  const [rows, header, key, objects, manifest, chunk, config] =
    await Promise.all([
      actor.list_vaults(),
      actor.get_vault_header(vault),
      actor.derive_vault_key({
        vault,
        operation: random(),
        transport: TransportSecretKey.random().publicKeyBytes(),
      }),
      actor.list_objects(vault, []),
      actor.get_manifest(vault, object, 1n),
      actor.get_chunk(vault, object, 1n, 0),
      actor.set_config([]),
    ]);
  return publicValue({
    principal: identity.getPrincipal(),
    rows,
    header,
    key,
    objects,
    manifest,
    chunk,
    config,
  });
}
export async function clientRead(
  canister: string,
  host: string,
  vault: number[],
) {
  const { identity, actor } = await connect(canister, host);
  const client = new VaultClient({ actor, identity, canister, local: true });
  try {
    const h = (await client.listVaults()).find(
      (h) => Array.from(h.id).join() === vault.join(),
    );
    if (!h) throw Error("MissingVault");
    await client.open(h);
    const items = await client.items();
    const documents = [];
    for (const item of items) {
      const doc = await client.read(item.revision);
      documents.push({
        title: doc.metadata.title,
        plaintext: new TextDecoder().decode(doc.plaintext),
        object: Array.from(item.revision.object),
      });
      doc.plaintext.fill(0);
    }
    return { principal: identity.getPrincipal().toText(), documents };
  } finally {
    client.destroy();
  }
}
let expiryActor: VaultActor | undefined;
let capturedExpirations: string[] = [];
export async function captureExpiry(canister: string, host: string) {
  const { identity, actor } = await connect(canister, host);
  expiryActor = actor;
  const delegated = identity as typeof identity & {
    getDelegation(): { delegations: { delegation: { expiration: bigint } }[] };
  };
  capturedExpirations = delegated
    .getDelegation()
    .delegations.map((d) => d.delegation.expiration.toString());
  return capturedExpirations;
}
export async function retainedCall() {
  if (!expiryActor) throw Error("ActorNotCaptured");
  try {
    const headers = await expiryActor.list_vaults();
    return { accepted: "Ok" in headers, expirations: capturedExpirations };
  } catch (e) {
    return {
      accepted: false,
      error: String(e),
      expirations: capturedExpirations,
    };
  }
}
// Requests a genuinely shorter delegation from II; never edits its signature or clock.
// After it completes, reload the production entry to restore that same SDK session.
export async function shortLogin(
  provider: string,
  origin: string,
  seconds: number,
) {
  const auth = await AuthClient.create({ idleOptions: { disableIdle: true } });
  await auth.logout();
  await new Promise<void>((resolve, reject) =>
    auth.login({
      identityProvider: provider,
      derivationOrigin: origin,
      maxTimeToLive: BigInt(seconds) * 1_000_000_000n,
      onSuccess: resolve,
      onError: reject,
    }),
  );
}
