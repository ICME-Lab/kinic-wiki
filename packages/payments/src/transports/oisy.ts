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
export async function openOisyTransport({ host, signerUrl, scopes, preferredOwner, onOpen, openSigner = FundingSigner.open.bind(FundingSigner), lifetime }: {
  host: string; signerUrl: string; scopes: readonly WalletAccess[]; openSigner?: OpenSigner; lifetime: Lifetime;
  preferredOwner?: string; onOpen(close: () => Promise<void>): void;
}) {
  // ICRC-49 does not include a replica URL. A production signer would use its
  // own network before our local certificate verifier could reject the reply.
  if (configuredLoopback(host) && !configuredLoopback(signerUrl)) throw new WalletFailure("unsupported-network");
  let closed = false;
  let signer: OisySigner;
  try {
    // connectSigner opens the popup in the original user gesture.
    signer = await openSigner({
      url: signerUrl, host, connectionOptions: timeout,
      onDisconnect() {
        if (closed) return;
        closed = true;
        lifetime.invalidate("disconnected");
      },
    });
  } catch (error) {
    // 4.1.3 reports a blocked window using this exact pre-connection error.
    if (error instanceof Error && error.message === "Unable to open the signer window.") throw new WalletFailure("popup-blocked");
    throw error;
  }
  const check = () => {
    if (closed) throw new WalletFailure("disconnected");
    lifetime.assertActive();
  };
  async function disconnect() {
    if (closed) return;
    closed = true;
    try { await signer.disconnect(); } catch { /* popup may already have closed */ }
  }
  function fail(reason: WalletIssue): never {
    lifetime.invalidate(reason);
    throw new WalletFailure(reason);
  }
  type Method = "icrc27_accounts" | "icrc49_call_canister";
  async function selectedOwner(required: Method[], expected?: string, guard: DispatchGuard = {}) {
    checkDispatch(guard);
    check();
    let states = await signer.permissions(options);
    check();
    checkDispatch(guard);
    const missing = required.filter(method => !states.some(s => s.scope.method === method && s.state === "granted"));
    if (missing.length) {
      states = await signer.requestPermissions({ ...options, params: { scopes: missing.map(method => ({ method })) } });
      check();
      checkDispatch(guard);
      if (!missing.every(method => states.some(s => s.scope.method === method && s.state === "granted"))) fail("permission-denied");
    }
    const accounts = await signer.accounts(options);
    check();
    if (!accounts.length) fail("empty-accounts");
    const eligible = accounts.filter(a => a.subaccount === undefined || a.subaccount === defaultSubaccount)
      .map(a => ownerPrincipal(a.owner));
    if (!eligible.length) fail("unsupported-account");
    if (expected && !eligible.includes(expected)) fail("account-changed");
    return expected ?? (preferredOwner && eligible.includes(preferredOwner) ? preferredOwner : eligible[0]);
  }
  async function validate(required: Method[], expected?: string, guard?: DispatchGuard) {
    try { return await selectedOwner(required, expected, guard); }
    catch (error) {
      if (error instanceof PaymentFailure) throw error;
      if (rpcCode(error) === 3000 || rpcCode(error) === 3001) fail("permission-denied");
      fail("connection-failed");
    }
  }
  try {
    onOpen(disconnect);
    const owner = await validate(["icrc27_accounts"]);
    let pending: Promise<unknown> = Promise.resolve();
    function serial<T>(operation: () => Promise<T>): Promise<T> {
      const result = pending.then(operation);
      pending = result.catch(() => {});
      return result;
    }
    return fundingTransport({
      account: { provider: "oisy", owner }, silentCheck: false, scopes, disconnect,
      revalidate: () => serial(async () => { await validate(["icrc27_accounts"], owner); check(); }),
      dispatch: request => serial(async () => {
        await validate(["icrc27_accounts", "icrc49_call_canister"], owner, request);
        checkDispatch(request);
        check();
        const params = { sender: owner, canisterId: request.canisterId, method: request.method,
          arg: uint8ArrayToBase64(request.arg), nonce: uint8ArrayToBase64(crypto.getRandomValues(new Uint8Array(16))) };
        let result;
        try { result = await signer.callCanister(params); }
        catch (error) {
          if (rpcCode(error) === 3000) fail("permission-denied");
          if (rpcCode(error) === 3001 && request.method === "icrc2_approve") throw new PaymentFailure("ApprovalRejected");
          // A lost signer response leaves the operation's outcome unknown.
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
