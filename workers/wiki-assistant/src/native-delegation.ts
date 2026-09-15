import { z } from "zod";
import { Delegation, DelegationChain, DelegationIdentity, type Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import type { DerEncodedPublicKey, Signature } from "@icp-sdk/core/agent";
import type { KinicDelegationMaterialV1 } from "@kinic/ii-server/internet-identity";
import { AssistantError } from "./contracts";

const base64 = z.string().min(4).max(16000).refine(value => {
  try { return btoa(atob(value)) === value; } catch { return false; }
});
const responseSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.string(),
  result: z.object({
    publicKey: base64,
    signerDelegation: z.array(z.object({
      delegation: z.object({
        pubkey: base64, expiration: z.string().regex(/^[0-9]{1,20}$/),
        targets: z.array(z.string()).max(100).optional(),
        permissions: z.enum(["queries", "all"]).optional(),
      }).strict(), signature: base64,
    }).strict()).min(1).max(8),
  }).strict(),
}).strict();
const bytes = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export const publicKeyBase64 = (key: Ed25519KeyIdentity) => btoa(String.fromCharCode(...new Uint8Array(key.getPublicKey().toDer())));

/** Structural checks only. The caller MUST perform an authenticated IC query
 * with this identity before accepting it: the replica validates chain signatures. */
export function nativeDelegation(value: unknown, requestId: string, key: Ed25519KeyIdentity,
  origin: string, canister: string, maxExpiry: number, now = Date.now()) {
  const response = responseSchema.parse(value);
  if (response.id !== requestId) throw new AssistantError("invalid_auth_state", 403);
  const hops = response.result.signerDelegation;
  if (hops.at(-1)!.delegation.pubkey !== publicKeyBase64(key))
    throw new AssistantError("invalid_delegation_key", 403);
  if (!hops.some(h => h.delegation.permissions === "queries"))
    throw new AssistantError("choose_questions_only", 403);
  const expiryNs = hops.reduce((min, h) => {
    const expires = BigInt(h.delegation.expiration);
    if (expires <= BigInt(now) * 1000000n || expires > 18446744073709551615n)
      throw new AssistantError("authentication_required", 401);
    if (h.delegation.targets && !h.delegation.targets.some(t => Principal.fromText(t).toText() === canister))
      throw new AssistantError("invalid_delegation_target", 403);
    return expires < min ? expires : min;
  }, 18446744073709551615n);
  if (expiryNs > BigInt(maxExpiry) * 1000000n)
    throw new AssistantError("invalid_delegation_expiry", 403);
  const chain = DelegationChain.fromDelegations(hops.map(h => ({
    delegation: new Delegation(bytes(h.delegation.pubkey), BigInt(h.delegation.expiration),
      h.delegation.targets?.map(t => Principal.fromText(t)), h.delegation.permissions),
    signature: bytes(h.signature) as Signature,
  })), bytes(response.result.publicKey) as DerEncodedPublicKey);
  const material: KinicDelegationMaterialV1 = {
    version: 1, targetOrigin: origin, expiresAt: Number(expiryNs / 1000000n),
    appKey: key.toJSON(), delegation: chain.toJSON(),
  };
  return { identity: DelegationIdentity.fromDelegation(key, chain), material };
}
