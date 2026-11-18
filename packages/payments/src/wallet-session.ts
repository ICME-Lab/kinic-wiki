import type { Identity } from "@icp-sdk/core/agent";
import type { FundingAccount } from "./types";
import { createIdentityTransport } from "./transports/identity";
import { openOisyTransport } from "./transports/oisy";
import { browserPlug, openPlugTransport } from "./transports/plug";
import { includesScopes, ownerPrincipal, type Lifetime, type ScopedTransport } from "./transports/common";
import { WalletFailure, type DispatchGuard, type FundingTransport, type OpenSigner, type PlugWallet, type WalletAccess, type WalletIssue } from "./wallet-types";

type External = "oisy" | "plug";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface WalletSessionOptions {
  origin: string;
  host: string;
  signerUrl: string;
  storage?: PreferenceStorage | null;
  legacyStorage?: PreferenceStorage | null;
  identity?: Identity;
  scopes?: readonly WalletAccess[];
  transports?: { openSigner?: OpenSigner; getPlug?: () => PlugWallet | undefined };
}
export interface WalletSessionSnapshot {
  readonly state: "disconnected" | "remembered" | "connecting" | "connected" | "reconnect-required";
  readonly account: Readonly<FundingAccount> | null;
  readonly transport: FundingTransport | null;
  readonly generation: number;
  readonly reason?: WalletIssue;
}
function browserStorage(key: "localStorage" | "sessionStorage"): Storage | null {
  try { return typeof window === "undefined" ? null : window[key]; } catch { return null; }
}
const legacyKey = "kinic-wiki.wallet-session";
function copyScopes(scopes: readonly WalletAccess[]) {
  return scopes.map(({ canisterId, methods }) => ({ canisterId, methods: [...methods] }));
}
// Extension consent may finish after the application session has ended.
// Keep the original extension object until the grant has settled and, when
// explicitly revoked, its disconnect has completed.
function pendingPlugConsent(wallet: PlugWallet | undefined, granted: boolean) {
  let revoke = false;
  let complete!: () => void;
  let failed!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { complete = resolve; failed = reject; });
  return {
    wallet, done,
    onGranted() { granted = true; },
    requestRelease() { revoke = true; return done; },
    async finish(unlock: () => void) {
      try {
        if (revoke && granted) await wallet?.disconnect?.();
        complete();
      } catch (error) {
        failed(error);
        throw error;
      } finally {
        unlock();
      }
    },
  };
}
export function createWalletSessionManager({ identity: suppliedIdentity, ...options }: WalletSessionOptions) {
  const origin = new URL(options.origin).origin;
  const host = new URL(options.host).origin;
  const prefKey = "kinic.payments.wallet.v1:" + JSON.stringify([origin, host]);
  const storage = options.storage === undefined ? browserStorage("localStorage") : options.storage;
  const legacy = options.legacyStorage === undefined ? browserStorage("sessionStorage") : options.legacyStorage;
  const initialScopes = copyScopes(options.scopes ?? []);
  const listeners = new Set<() => void>();
  let current: WalletSessionSnapshot = Object.freeze({ state: "disconnected", account: null, transport: null, generation: 0 });
  let active: ScopedTransport | undefined;
  let grants: WalletAccess[] = [];
  let identity = suppliedIdentity;
  let connection = Symbol();
  let work = Symbol();
  let ended = false;
  let restored = false;
  let openingOisy = false;
  let pendingPlug: ReturnType<typeof pendingPlugConsent> | undefined;
  let releasingPlug: Promise<void> | undefined;
  let closeOpening: (() => Promise<void>) | undefined;

  function publish(state: WalletSessionSnapshot["state"], account: FundingAccount | null, transport: FundingTransport | null, reason?: WalletIssue) {
    current = Object.freeze({ state, account: account && Object.freeze({ ...account }), transport, reason, generation: current.generation });
    for (const listener of listeners) listener();
  }
  function invalidateWork() {
    work = Symbol();
    current = Object.freeze({ ...current, generation: current.generation + 1 });
  }
  function advance() {
    invalidateWork();
    connection = Symbol();
    void closeOpening?.();
    closeOpening = undefined;
    active = undefined;
    grants = [];
  }
  function save(account: FundingAccount) {
    try { storage?.setItem(prefKey, JSON.stringify({ version: 1, origin, host, ...account })); } catch { /* preference storage is optional */ }
  }
  function clear() {
    try { storage?.removeItem(prefKey); } catch { /* private storage */ }
    try { legacy?.removeItem(legacyKey); } catch { /* private storage */ }
  }
  function readPreference(): FundingAccount | null {
    try {
      const raw = storage?.getItem(prefKey);
      const old = raw == null ? legacy?.getItem(legacyKey) : null;
      if (!raw && !old) return null;
      const entry = JSON.parse((raw ?? old)!);
      if (!entry || (entry.provider !== "oisy" && entry.provider !== "plug")) return null;
      if (!old && (entry.version !== 1 || entry.host !== host || entry.origin !== origin)) return null;
      const owner = old ? entry.principal : entry.owner;
      if (typeof owner !== "string") return null;
      const account = { provider: entry.provider as External, owner: ownerPrincipal(owner) };
      if (old) {
        save(account);
        legacy?.removeItem(legacyKey);
      }
      return account;
    } catch { return null; }
  }
  const capture = () => work;
  const isCurrent = (token: unknown) => !ended && token === work;
  function keepAlive(expected = connection): Lifetime {
    return {
      assertActive() { if (ended || expected !== connection) throw new WalletFailure("disconnected"); },
      invalidate(reason) {
        if (ended || expected !== connection) return;
        const previous = active;
        advance();
        publish("reconnect-required", current.account, null, reason);
        if (previous?.account.provider === "oisy") void previous.disconnect();
      },
    };
  }
  // The wrapper prevents retaining or widening a stale transport after source changes.
  function expose(raw: FundingTransport, lifetime: Lifetime, close: () => Promise<void>): FundingTransport {
    const token = capture();
    function assertCurrent() {
      lifetime.assertActive();
      if (!isCurrent(token)) throw new WalletFailure("disconnected");
    }
    function guarded(guard?: DispatchGuard) {
      return () => isCurrent(token) && (!guard?.isCurrent || guard.isCurrent());
    }
    return Object.freeze({
      account: raw.account, silentCheck: raw.silentCheck,
      async revalidate() {
        assertCurrent();
        await raw.revalidate();
        assertCurrent();
      },
      async call(request) {
        assertCurrent();
        const reply = await raw.call({ ...request, isCurrent: guarded(request) });
        assertCurrent();
        return reply;
      },
      async approve(ledger, args, guard) {
        assertCurrent();
        const block = await raw.approve(ledger, args, { isCurrent: guarded(guard) });
        assertCurrent();
        return block;
      },
      async disconnect() {
        assertCurrent();
        await close();
      },
    } satisfies FundingTransport);
  }
  function attach(raw: ScopedTransport, scopes: readonly WalletAccess[], lifetime: Lifetime) {
    lifetime.assertActive();
    active = raw;
    grants = copyScopes(scopes);
    const transport = expose(raw, lifetime, disconnect);
    publish("connected", raw.account, transport);
    return transport;
  }
  function useIdentity() {
    if (!identity || identity.getPrincipal().isAnonymous()) {
      publish("disconnected", null, null);
      return;
    }
    const lifetime = keepAlive();
    attach(createIdentityTransport({ host, identity, scopes: initialScopes, lifetime }), initialScopes, lifetime);
  }
  function getIdentityTransport(scopes: readonly WalletAccess[]): FundingTransport | null {
    if (ended || !identity || identity.getPrincipal().isAnonymous()) return null;
    const lifetime = keepAlive();
    const raw = createIdentityTransport({ host, identity, scopes, lifetime });
    return expose(raw, lifetime, raw.disconnect);
  }
  async function start(provider: External, scopes: readonly WalletAccess[], preferred: FundingAccount | null, restoring: boolean) {
    if (ended || current.state === "connecting" || (provider === "oisy" && openingOisy)) throw new WalletFailure("disconnected");
    if (provider === "plug" && (pendingPlug || releasingPlug)) throw new WalletFailure("connection-failed");
    const requested = copyScopes(scopes);
    const previous = active;
    const plug = provider === "plug" ? pendingPlugConsent((options.transports?.getPlug ?? browserPlug)(),
      restoring || previous?.account.provider === "plug") : undefined;
    if (plug) pendingPlug = plug;
    advance();
    const generation = connection;
    const lifetime = keepAlive(generation);
    if (provider === "oisy") openingOisy = true;
    publish("connecting", preferred, null);
    if (previous?.account.provider === "oisy") void previous.disconnect();
    try {
      lifetime.assertActive();
      const raw = plug
        ? await openPlugTransport({
            host, scopes: requested, plug: plug.wallet, onGranted: plug.onGranted, lifetime,
            restoreOwner: restoring ? preferred?.owner : undefined,
          })
        : await openOisyTransport({
            host, scopes: requested, signerUrl: options.signerUrl, openSigner: options.transports?.openSigner,
            preferredOwner: preferred?.owner, lifetime,
            onOpen(close) {
              if (generation === connection) closeOpening = close;
              else void close();
            },
          });
      if (ended || generation !== connection) {
        if (provider === "oisy") await raw.disconnect();
        throw new WalletFailure("disconnected");
      }
      closeOpening = undefined;
      if (plug) pendingPlug = undefined; // The attached transport now owns disconnect.
      save(raw.account);
      return attach(raw, requested, lifetime);
    } catch (error) {
      const reason = error instanceof WalletFailure ? error.reason : "connection-failed";
      lifetime.invalidate(reason);
      throw new WalletFailure(reason);
    } finally {
      if (provider === "oisy") openingOisy = false;
      if (plug) {
        await plug.finish(() => { if (pendingPlug === plug) pendingPlug = undefined; });
      }
    }
  }
  async function connect(provider: External, scopes: readonly WalletAccess[]): Promise<FundingTransport> {
    restored = true;
    const previous = active;
    if (previous?.account.provider === provider) {
      const generation = connection;
      const requested = copyScopes(scopes);
      if (includesScopes(grants, requested) || provider === "oisy") {
        await previous.revalidate();
        const lifetime = keepAlive(generation);
        lifetime.assertActive();
        if (includesScopes(grants, requested) && includesScopes(requested, grants)) return current.transport!;
        invalidateWork();
        return attach(previous.withScopes(requested), requested, lifetime);
      }
    }
    const preferred = current.account?.provider === provider ? current.account : null;
    return start(provider, scopes, preferred, false);
  }
  async function restore() {
    if (ended || restored) return;
    restored = true;
    const account = readPreference();
    if (!account) { if (!active) useIdentity(); return; }
    if (account.provider === "plug") {
      // Whitelists are not persisted. The next explicit scope expansion obtains consent.
      const generation = connection;
      try {
        if (pendingPlug) await pendingPlug.done;
        if (!ended && generation === connection) await start("plug", [], account, true);
      } catch { /* state records the reason */ }
    } else {
      advance();
      publish("remembered", account, null);
    }
  }
  async function revalidate(scopes: readonly WalletAccess[]) {
    const transport = current.transport;
    if (!transport) throw new WalletFailure("disconnected");
    if (!includesScopes(grants, scopes)) throw new WalletFailure("scope-required");
    await transport.revalidate();
    return transport;
  }
  async function release(previous: FundingTransport | undefined): Promise<void> {
    const lateGrant = pendingPlug?.requestRelease();
    if (previous?.account.provider === "plug" && !lateGrant) {
      releasingPlug = previous.disconnect().finally(() => { releasingPlug = undefined; });
      return releasingPlug;
    }
    const other = previous?.account.provider === "plug" ? undefined : previous?.disconnect();
    await Promise.all([other, lateGrant, releasingPlug]);
  }
  function setIdentity(next?: Identity) {
    if (ended || next === identity) return;
    const wasSignedIn = identity && !identity.getPrincipal().isAnonymous();
    identity = next;
    const signedOut = wasSignedIn && (!next || next.getPrincipal().isAnonymous());
    // App auth can finish restoring after the remembered wallet. Changing the
    // beneficiary invalidates every payment continuation even when its signer survives.
    if (!signedOut && (current.state === "connecting" || (current.account && current.account.provider !== "ii"))) {
      invalidateWork();
      if (active) attach(active, grants, keepAlive());
      else publish(current.state, current.account, null, current.reason);
      return;
    }
    const previous = active;
    advance();
    if (signedOut) void release(previous).catch(() => {});
    else if (previous) void previous.disconnect().catch(() => {});
    if (signedOut) { restored = true; clear(); }
    useIdentity();
  }
  async function disconnect() {
    if (ended) return;
    const previous = active;
    restored = true;
    advance();
    const cleanup = release(previous);
    clear();
    publish("disconnected", null, null);
    await cleanup;
  }
  function suspend() {
    if (ended) return;
    const previous = active;
    advance();
    restored = false;
    publish("disconnected", null, null);
    // Plug maintains its own extension session across reload. Only an explicit
    // disconnect revokes it. OISY's popup belongs to this page.
    if (previous?.account.provider === "oisy") void previous.disconnect();
  }
  function destroy() {
    suspend();
    ended = true;
    identity = undefined;
    listeners.clear();
  }
  useIdentity();
  return { connect, restore, revalidate, setIdentity, getIdentityTransport, capture, isCurrent, disconnect, suspend, destroy,
    getSnapshot: () => current, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
export type WalletSessionManager = ReturnType<typeof createWalletSessionManager>;
