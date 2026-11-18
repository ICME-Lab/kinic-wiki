import { WalletFailure, type PlugWallet, type WalletAccess, type WalletIssue } from "../wallet-types";
import { actorReply, checkDispatch, configuredLoopback, fundingTransport, ownerPrincipal, scopeMap, type Lifetime } from "./common";

export function browserPlug(): PlugWallet | undefined {
  if (typeof window === "undefined") return;
  return (window as Window & { ic?: { plug?: PlugWallet } }).ic?.plug;
}
export async function openPlugTransport({ host, scopes, plug, lifetime, restoreOwner, onGranted }: {
  host: string; scopes: readonly WalletAccess[]; plug?: PlugWallet; lifetime: Lifetime; restoreOwner?: string; onGranted(): void;
}) {
  if (!plug) throw new WalletFailure("extension-missing");
  const wallet = plug;
  let released = false;
  function check() {
    if (released) throw new WalletFailure("disconnected");
    lifetime.assertActive();
  }
  function fail(reason: WalletIssue): never {
    lifetime.invalidate(reason);
    throw new WalletFailure(reason);
  }
  function checkNetwork(update: boolean) {
    const agentHost = wallet.agent?.host;
    if (agentHost ? new URL(agentHost).origin !== host : update && configuredLoopback(host)) fail("unsupported-network");
  }
  async function verifyOwner(expected?: string, update = false) {
    check();
    try {
      if (wallet.isWalletLocked || (wallet.isConnected && !(await wallet.isConnected()))) fail("disconnected");
      check();
      if (!wallet.agent) fail("disconnected");
      checkNetwork(update);
      const agent = wallet.agent;
      const owner = ownerPrincipal((await agent.getPrincipal()).toText());
      if (wallet.agent !== agent) fail("account-changed");
      check();
      if (expected && owner !== expected) fail("account-changed");
      return owner;
    } catch (error) {
      if (error instanceof WalletFailure) throw error;
      fail("connection-failed");
    }
  }
  if (restoreOwner) {
    if (!wallet.isConnected) throw new WalletFailure("disconnected");
  } else {
    let granted: unknown;
    try {
      granted = await wallet.requestConnect({
        whitelist: [...scopeMap(scopes).keys()], host, timeout: 120_000,
        onConnectionUpdate: () => lifetime.invalidate("account-changed"),
      });
    } catch (error) {
      // Plug's AGENT_REJECTED shares code 401 with unrelated provider errors.
      const message = error && typeof error === "object" && "message" in error ? error.message : error;
      if (message === "The agent creation was rejected.") throw new WalletFailure("permission-denied");
      throw error;
    }
    if (!granted) throw new WalletFailure("permission-denied");
    onGranted();
  }
  const owner = await verifyOwner(restoreOwner);
  wallet.onExternalDisconnect?.(() => lifetime.invalidate("disconnected"));
  wallet.onLockStateChange?.(locked => { if (locked) lifetime.invalidate("disconnected"); });
  return fundingTransport({
    account: { provider: "plug", owner }, scopes, silentCheck: true,
    revalidate: async () => { await verifyOwner(owner); },
    async disconnect() {
      if (released) return;
      released = true;
      await wallet.disconnect?.();
    },
    async dispatch(request) {
      await verifyOwner(owner, request.mode === "update");
      check();
      checkDispatch(request);
      const actor = await wallet.createActor({ canisterId: request.canisterId, interfaceFactory: request.interfaceFactory });
      checkDispatch(request);
      await verifyOwner(owner, request.mode === "update");
      return actorReply(actor, request, () => { check(); checkNetwork(request.mode === "update"); });
    },
  });
}
