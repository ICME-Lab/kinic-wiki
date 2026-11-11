// Test-only same-origin inspector. Uses the actual persisted II delegation and
// real agent/actor calls; never replaces auth, WebAuthn, actors or responses.
import { AuthClient } from "@icp-sdk/auth/client";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { idlFactory } from "../../packages/vault-candid/index.js";
export async function readback(canister: string, host: string) {
  // This short-lived inspector has no idle callback; the real app's idle manager
  // remains enabled and is the subject of the browser test.
  const auth = await AuthClient.create({ idleOptions: { disableIdle: true } });
  if (!(await auth.isAuthenticated()))
    throw Error("ActualIIAuthenticationRequired");
  const agent = await HttpAgent.create({
    host,
    identity: auth.getIdentity(),
    shouldFetchRootKey: true,
  });
  const actor: any = Actor.createActor(idlFactory, {
    agent,
    canisterId: canister,
  });
  const [incident, restore, headers, credentials, balance, capacity, payments] =
    await Promise.all([
      actor.incident_status(),
      actor.restore_admission_status(),
      actor.list_vaults(),
      actor.list_credentials(),
      actor.account_balance(),
      actor.global_capacity(),
      actor.list_payments(),
    ]);
  const publicValue = (value: any): any => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Principal) return value.toText();
    if (value instanceof Uint8Array) return Array.from(value);
    if (Array.isArray(value)) return value.map(publicValue);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, publicValue(v)]),
      );
    return value;
  };
  return publicValue({
    principal: auth.getIdentity().getPrincipal().toText(),
    incident,
    restore,
    headers,
    credentials,
    balance,
    capacity,
    payments,
  });
}
