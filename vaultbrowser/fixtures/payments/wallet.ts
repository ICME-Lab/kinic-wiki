// Built into a disposable Playwright context only. No persistent provider or signing keys.
import { Actor, Cbor, HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { idlFactory as consentIdl, type _SERVICE } from "@kinic/vault-candid";
import type { IDL } from "@icp-sdk/core/candid";

type Setup = {
  wikiURL: string;
  vaultURL: string;
  signerURL: string;
  replica: string;
  ids: { vault: string; wiki: string; ledger: string };
  seed: number[];
};
const scopes = ["icrc27_accounts", "icrc49_call_canister"];
function local(raw: string) {
  const { hostname, protocol, username, password } = new URL(raw);
  if (
    protocol !== "http:" ||
    username ||
    password ||
    !(
      ["127.0.0.1", "localhost"].includes(hostname) ||
      hostname.endsWith(".localhost")
    )
  )
    throw Error("A local payment fixture requires a loopback HTTP origin");
}
export function install(config: Setup) {
  const { wikiURL, vaultURL, signerURL, replica, ids } = config;
  for (const target of [wikiURL, vaultURL, signerURL, replica]) local(target);
  if (
    ![wikiURL, vaultURL].includes(location.origin) &&
    location.href !== signerURL
  )
    return;
  const allowed = new Map([
    [ids.ledger, ["icrc2_approve"]],
    [
      ids.vault,
      [
        "quote_purchase",
        "pay_purchase",
        "payment_status",
        "list_payments",
        "reconcile_purchase",
        "cancel_quote",
      ],
    ],
    [
      ids.wiki,
      ["purchase_database_cycles", "list_database_cycles_pending_purchases"],
    ],
  ]);
  const events = window as Window & {
    recordLocalWalletEvent: (event: string) => Promise<void>;
  };
  const identity = Ed25519KeyIdentity.generate(Uint8Array.from(config.seed));
  const owner = identity.getPrincipal();
  const expectedHost =
    location.origin === wikiURL
      ? replica
      : replica.replace("127.0.0.1", "localhost");
  const agent = HttpAgent.createSync({
    host: expectedHost,
    identity,
    retryTimes: 0,
  });
  const rootKey = () => agent.fetchRootKey();
  const b64 = (bytes: Uint8Array) =>
    btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
  const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  if (location.href === signerURL) {
    const grants = new Set<string>();
    let origin: string | undefined;
    window.addEventListener(
      "message",
      async ({ data, source, origin: from }) => {
        if (
          source !== opener ||
          ![wikiURL, vaultURL].includes(from) ||
          (origin && from !== origin) ||
          data?.jsonrpc !== "2.0"
        )
          return;
        origin = from;
        const { id, method, params } = data;
        const reply = (message: object) =>
          opener.postMessage({ id, jsonrpc: "2.0", ...message }, from);
        try {
          const states = () =>
            scopes.map((method) => ({
              scope: { method },
              state: grants.has(method) ? "granted" : "ask_on_use",
            }));
          if (method === "icrc29_status") return reply({ result: "ready" });
          if (method === "icrc25_permissions")
            return reply({ result: { scopes: states() } });
          if (method === "icrc25_request_permissions") {
            for (const scope of params.scopes)
              if (scopes.includes(scope.method)) grants.add(scope.method);
            return reply({ result: { scopes: states() } });
          }
          if (!grants.has(method)) throw Error("Fixture permission missing");
          if (method === "icrc27_accounts")
            return reply({ result: { accounts: [{ owner: owner.toText() }] } });
          if (
            method !== "icrc49_call_canister" ||
            params.sender !== owner.toText() ||
            !allowed.get(params.canisterId)?.includes(params.method)
          )
            throw Error("Unscoped signer request");
          await rootKey();
          const arg = bytes(params.arg);
          if (params.canisterId !== ids.ledger) {
            const actor = Actor.createActor<_SERVICE>(consentIdl, { agent, canisterId: params.canisterId });
            const consent = await actor.icrc21_canister_call_consent_message({
              method: params.method, arg,
              user_preferences: { metadata: { language: "en", utc_offset_minutes: [] }, device_spec: [] },
            });
            if ("Err" in consent) throw Error("Canister declined consent for " + params.method);
            await events.recordLocalWalletEvent("consent:" + params.method);
          }
          const response = await agent.update(
            Principal.fromText(params.canisterId),
            {
              methodName: params.method,
              arg,
              nonce: bytes(params.nonce),
              effectiveCanisterId: params.canisterId,
            },
          );
          await events.recordLocalWalletEvent("signed:" + params.method);
          reply({
            result: {
              contentMap: b64(Cbor.encode(response.requestDetails)),
              certificate: b64(response.rawCertificate),
            },
          });
        } catch (error) {
          console.error("Local signer:", String(error));
          reply({
            error: { code: 3001, message: "Local fixture request rejected" },
          });
        }
      },
    );
    return;
  }
  const stored = "shared-payments.plug-granted";
  let granted = new Set<string>(
    JSON.parse(sessionStorage.getItem(stored) ?? "[]"),
  );
  Object.assign(window, {
    ic: {
      plug: {
        agent,
        isConnected: async () => granted.size > 0,
        async requestConnect({
          host,
          whitelist,
        }: {
          host: string;
          whitelist: string[];
        }) {
          if (
            host !== expectedHost ||
            !whitelist.length ||
            whitelist.some((id) => !allowed.has(id))
          )
            return false;
          await rootKey();
          await events.recordLocalWalletEvent("plugGrant");
          granted = new Set(whitelist);
          sessionStorage.setItem(stored, JSON.stringify(whitelist));
          return true;
        },
        async createActor({
          canisterId,
          interfaceFactory,
        }: {
          canisterId: string;
          interfaceFactory: IDL.InterfaceFactory;
        }) {
          if (!granted.has(canisterId))
            throw Error("Unapproved Plug fixture scope");
          await rootKey();
          const actor = Actor.createActor(interfaceFactory, {
            agent,
            canisterId,
          });
          return Object.fromEntries(
            allowed
              .get(canisterId)!
              .filter((method) => typeof actor[method] === "function")
              .map((method) => [method, actor[method]]),
          );
        },
        async disconnect() {
          granted.clear();
          sessionStorage.removeItem(stored);
        },
      },
    },
  });
}
