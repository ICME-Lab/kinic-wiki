import type { IcrcCallCanisterRequestParams, RelyingPartyOptions } from "@dfinity/oisy-wallet-signer";
import { RelyingParty } from "@dfinity/oisy-wallet-signer/relying-party";
import { uint8ArrayToBase64 } from "@dfinity/utils";
import { PaymentFailure } from "../errors";
import { WalletFailure, type OpenSigner, type OisySigner, type DispatchGuard, type WalletAccess, type WalletIssue } from "../wallet-types";
import { checkDispatch, configuredLoopback, fundingTransport, ownerPrincipal, type Lifetime } from "./common";
import { certifiedReply } from "./certified-reply";

const timeout = { timeoutInMilliseconds: 120_000 };
const options = { options: timeout };
const defaultSubaccount = uint8ArrayToBase64(new Uint8Array(32));
class FundingSigner extends RelyingParty {
  static open({ onDisconnect, host, ...rest }: RelyingPartyOptions): Promise<FundingSigner> {
    return this.connectSigner({ options: rest, init: params => new FundingSigner({ ...params, onDisconnect, host }) });
  }
  callCanister(params: IcrcCallCanisterRequestParams) {
    return this.call({ params, ...options });
  }
}

// Each SDK entry bundles its own Error constructor. The RPC response carries the
// standardized numeric code; never infer consent or dispatch outcomes from text.
function rpcCode(error: unknown) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
export type OisyWindowPolicy = {
  /** Close the signer once no operation needs it. Each signature then reopens it in a user gesture. */
  closeWhenIdle?: boolean;
  /** Relying-party window features. An empty string opens a browser tab. */
  windowOptions?: RelyingPartyOptions["windowOptions"];
};
export async function openOisyTransport({ host, signerUrl, scopes, preferredOwner, onOpen, openSigner = FundingSigner.open.bind(FundingSigner), lifetime,
  closeWhenIdle = false, windowOptions }: {
  host: string; signerUrl: string; scopes: readonly WalletAccess[]; openSigner?: OpenSigner; lifetime: Lifetime;
  preferredOwner?: string; onOpen(close: () => Promise<void>): void;
} & OisyWindowPolicy) {
  // ICRC-49 does not include a replica URL. A production signer would use its
  // own network before our local certificate verifier could reject the reply.
  if (configuredLoopback(host) && !configuredLoopback(signerUrl)) throw new WalletFailure("unsupported-network");
  let ended = false;
  type Live = { handle: OisySigner; closed: Promise<never> };
  let signer: Live | undefined;
  let opening: Promise<Live> | undefined;
  let holds = 0, active = 0;
  // Opens (or reuses) the signer. The window opens synchronously, so callers
  // must reach this from the user's click without awaiting first.
  function connectSigner(): Promise<Live> {
    if (ended) return Promise.reject(new WalletFailure("disconnected"));
    if (signer) return Promise.resolve(signer);
    if (opening) return opening;
    let entry: Live | undefined;
    let lost = false;
    let markClosed!: (error: unknown) => void;
    const closed = new Promise<never>((_, reject) => { markClosed = reject; });
    closed.catch(() => {});
    const started = (async (): Promise<Live> => {
      let handle: OisySigner;
      try {
        handle = await openSigner({
          url: signerUrl, host, connectionOptions: timeout, ...(windowOptions === undefined ? {} : { windowOptions }),
          onDisconnect() {
            markClosed(new WalletFailure("disconnected"));
            if (entry && signer === entry) signer = undefined;
            if (!entry) lost = true;
            if (ended) return;
            // A retained signer is the session. An idle-closing one is reopened per signature.
            if (!closeWhenIdle) {
              ended = true;
              lifetime.invalidate("disconnected");
            }
          },
        });
      } catch (error) {
        // 4.1.3 reports a blocked window using this exact pre-connection error.
        if (error instanceof Error && error.message === "Unable to open the signer window.") throw new WalletFailure("popup-blocked");
        throw error;
      }
      if (ended || lost) {
        try { await handle.disconnect(); } catch { /* the window may already be gone */ }
        throw new WalletFailure("disconnected");
      }
      entry = { handle, closed };
      signer = entry;
      idle();
      return entry;
    })();
    opening = started;
    void started.catch(() => {}).then(() => { if (opening === started) opening = undefined; });
    return started;
  }
  function idle() {
    if (!closeWhenIdle || holds > 0 || active > 0 || !signer) return;
    const { handle } = signer;
    signer = undefined;
    void handle.disconnect().catch(() => { /* already closed */ });
  }
  function hold(): () => void {
    if (ended) return () => {};
    holds++;
    void connectSigner().catch(() => { /* the held operation reports the failure */ });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds--;
      idle();
    };
  }
  const check = () => {
    if (ended) throw new WalletFailure("disconnected");
    lifetime.assertActive();
  };
  async function disconnect() {
    if (ended) return;
    ended = true;
    const current = signer;
    signer = undefined;
    if (current) {
      try { await current.handle.disconnect(); } catch { /* popup may already have closed */ }
    }
  }
  function fail(reason: WalletIssue): never {
    lifetime.invalidate(reason);
    throw new WalletFailure(reason);
  }
  // A request to a closed window would otherwise wait for its full timeout.
  const using = <T>(live: Live, request: Promise<T>) => Promise.race([request, live.closed]);
  type Method = "icrc27_accounts" | "icrc49_call_canister";
  async function selectedOwner(live: Live, required: Method[], expected?: string, guard: DispatchGuard = {}) {
    checkDispatch(guard);
    check();
    let states = await using(live, live.handle.permissions(options));
    check();
    checkDispatch(guard);
    const missing = required.filter(method => !states.some(s => s.scope.method === method && s.state === "granted"));
    if (missing.length) {
      states = await using(live, live.handle.requestPermissions({ ...options, params: { scopes: missing.map(method => ({ method })) } }));
      check();
      checkDispatch(guard);
      if (!missing.every(method => states.some(s => s.scope.method === method && s.state === "granted"))) fail("permission-denied");
    }
    const accounts = await using(live, live.handle.accounts(options));
    check();
    if (!accounts.length) fail("empty-accounts");
    const eligible = accounts.filter(a => a.subaccount === undefined || a.subaccount === defaultSubaccount)
      .map(a => ownerPrincipal(a.owner));
    if (!eligible.length) fail("unsupported-account");
    if (expected && !eligible.includes(expected)) fail("account-changed");
    return expected ?? (preferredOwner && eligible.includes(preferredOwner) ? preferredOwner : eligible[0]);
  }
  async function validate(live: Live, required: Method[], expected?: string, guard?: DispatchGuard) {
    try { return await selectedOwner(live, required, expected, guard); }
    catch (error) {
      if (error instanceof PaymentFailure) throw error;
      if (rpcCode(error) === 3000 || rpcCode(error) === 3001) fail("permission-denied");
      fail("connection-failed");
    }
  }
  let pending: Promise<unknown> = Promise.resolve();
  // Requests are serialized. Opening starts immediately so a click can open the window.
  function serial<T>(operation: (live: Live) => Promise<T>): Promise<T> {
    active++;
    const ready = connectSigner();
    ready.catch(() => { /* reported through result */ });
    const result = pending.then(() => ready).then(operation);
    pending = result.catch(() => {});
    void result.catch(() => {}).then(() => { active--; idle(); });
    return result;
  }
  try {
    onOpen(disconnect);
    const owner = await serial(live => validate(live, ["icrc27_accounts"]));
    return fundingTransport({
      account: { provider: "oisy", owner }, silentCheck: false, scopes, disconnect, holdSigner: hold,
      revalidate: () => serial(async live => { await validate(live, ["icrc27_accounts"], owner); check(); }),
      dispatch: request => serial(async live => {
        await validate(live, ["icrc27_accounts", "icrc49_call_canister"], owner, request);
        checkDispatch(request);
        check();
        const params = { sender: owner, canisterId: request.canisterId, method: request.method,
          arg: uint8ArrayToBase64(request.arg), nonce: uint8ArrayToBase64(crypto.getRandomValues(new Uint8Array(16))) };
        let result;
        try { result = await using(live, live.handle.callCanister(params)); }
        catch (error) {
          if (rpcCode(error) === 3000) fail("permission-denied");
          if (rpcCode(error) === 3001 && request.method === "icrc2_approve") throw new PaymentFailure("ApprovalRejected");
          // A lost signer response or a closed window leaves the operation's outcome unknown.
          throw new PaymentFailure("Unknown");
        }
        check();
        return certifiedReply(host, params, result);
      }),
    });
  } catch (error) {
    await disconnect();
    throw error;
  }
}
