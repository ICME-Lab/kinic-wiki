import { HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { createWikiBridgeActor } from "@kinic/credit-bridge-candid";
import { configuredBridgeOrigins } from "@kinic/credit-bridge-candid/browser";
import { listDatabasesAuthenticated } from "./vfs-client/cycles";
import { isLocalHost } from "./vfs-client/actor";
export function creditOrigins() {
  return configuredBridgeOrigins(import.meta.env);
}
export async function wikiCreditActor(canisterId: string, identity: Identity) {
  const host = import.meta.env.VITE_WIKI_IC_HOST || "https://icp0.io";
  const agent = HttpAgent.createSync({ host, identity });
  if (isLocalHost(host)) await agent.fetchRootKey();
  return createWikiBridgeActor(agent, canisterId);
}
export async function ownerDatabases(canisterId: string, identity: Identity) {
  return (await listDatabasesAuthenticated(canisterId, identity)).filter(
    (db) => db.role === "owner" && db.status !== "deleted",
  );
}
