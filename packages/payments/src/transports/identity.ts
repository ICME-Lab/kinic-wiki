import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import type { WalletAccess } from "../wallet-types";
import { WalletFailure } from "../wallet-types";
import { actorReply, configuredLoopback, fundingTransport, ownerPrincipal, type Lifetime } from "./common";

export function createIdentityTransport({ host, identity, scopes, lifetime }: {
  host: string; identity: Identity; scopes: readonly WalletAccess[]; lifetime?: Lifetime;
}) {
  const owner = ownerPrincipal(identity.getPrincipal().toText());
  const agent = HttpAgent.createSync({ host, identity, retryTimes: 0 });
  let closed = false;
  function check() {
    if (closed) throw new WalletFailure("disconnected");
    lifetime?.assertActive();
    if (owner !== identity.getPrincipal().toText()) {
      closed = true;
      lifetime?.invalidate("account-changed");
      throw new WalletFailure("account-changed");
    }
  }
  return fundingTransport({
    account: { provider: "ii", owner }, silentCheck: true, scopes,
    revalidate: async () => check(), disconnect: async () => { closed = true; },
    async dispatch(request) {
      check();
      if (configuredLoopback(host)) await agent.fetchRootKey();
      const actor = Actor.createActor(request.interfaceFactory, { agent, canisterId: request.canisterId });
      return actorReply(actor, request, check);
    },
  });
}
