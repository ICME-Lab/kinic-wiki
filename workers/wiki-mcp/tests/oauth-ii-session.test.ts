import { afterEach, describe, expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { encryptJson, sha256 } from "@kinic/ii-server/crypto";
import * as ii from "@kinic/ii-server/internet-identity";
import { McpAuthStateV5, sessionKeyContext } from "../src/auth/state.js";
import { II_SESSION_TTL_MS } from "../src/auth/session-policy.js";

const targetOrigin = "https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app";
const resource = "https://fixture.invalid/mcp";
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const hour = 60 * 60_000;

// Model II's one-active-grant-per-identity rule at the external actor boundary.
// Upstream: dfinity/internet-identity, mcp_register_v2_is_multi_use_but_sessions_replace.
// OAuth state, encryption, minting and identity restoration use production code;
// storage and II replies are fixtures, not an actual DO runtime or II canister.
function iiFixture(expiresAt: number, permissions: ii.IiPermission) {
  const roots = new Map<string, ReturnType<typeof ii.generateIiKey>>();
  const grants = new Map<string, { principal: string; root: ReturnType<typeof ii.generateIiKey> }>();
  function actorFor(caller: Principal, registeringIdentity?: string): ii.InternetIdentityActor {
    const grant = () => expiresAt > Date.now()
      ? [...grants.values()].find(value => value.principal === caller.toText())
      : undefined;
    const unauthorized = () => ({ Err: { Unauthorized: caller } });
    return {
      async mcp_register_v2(publicKey) {
        if (!registeringIdentity) return { Err: "Registration identity required" };
        let root = roots.get(registeringIdentity);
        if (!root) {
          root = ii.generateIiKey();
          roots.set(registeringIdentity, root);
        }
        grants.set(registeringIdentity, { principal: Principal.selfAuthenticating(publicKey).toText(), root });
        return { Ok: { expiration: BigInt(expiresAt) * 1_000_000n,
          permissions: permissions === "queries" ? { queries: null } : { all: null } } };
      },
      async mcp_get_accounts() {
        return grant() ? { Ok: [] } : unauthorized();
      },
      async mcp_prepare_delegation() {
        const current = grant();
        if (!current) return unauthorized();
        return { Ok: { user_key: new Uint8Array(current.root.getPublicKey().toDer()),
          expiration: BigInt(Math.min(expiresAt, Date.now() + 5 * 60_000)) * 1_000_000n,
          account_number: [] } };
      },
      async mcp_get_delegation(_origin, _account, publicKey, expiration) {
        if (!grant()) return unauthorized();
        return { Ok: { delegation: { pubkey: publicKey, expiration, targets: [],
          permissions: permissions === "queries" ? ["queries"] : [] }, signature: new Uint8Array(64) } };
      }
    };
  }
  return {
    actorFor: (key: ReturnType<typeof ii.generateIiKey>) => actorFor(key.getPrincipal()),
    register: (identity: string, key: ReturnType<typeof ii.generateIiKey>) =>
      ii.redeemRegistration(ii.generateIiKey(), key, "", actorFor(Principal.anonymous(), identity))
  };
}

function memoryState() {
  const records = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(records.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown) { records.set(key, structuredClone(value)); },
    async deleteAll() { records.clear(); },
    async setAlarm() {},
    async deleteAlarm() {},
    async transaction<T>(callback: (tx: DurableObjectTransaction) => Promise<T>) {
      return callback(storage as unknown as DurableObjectTransaction);
    }
  };
  return { records, state: { storage } as unknown as DurableObjectState };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(["queries", "all"] as const)("OAuth renewal with %s II approval", permissions => {
  it.each(["none", "same-identity", "different-identity"] as const)(
    "handles another registration for %s after the real mint cache expires", async registrationMode => {
      vi.useFakeTimers();
      const now = Date.UTC(2026, 9, 15), expiresAt = now + II_SESSION_TTL_MS;
      vi.setSystemTime(now);
      const fixture = iiFixture(expiresAt, permissions);
      const mint = ii.mintKinicDelegation;
      const minted = vi.spyOn(ii, "mintKinicDelegation").mockImplementation((key, origin) =>
        mint(key, origin, fixture.actorFor(key)));
      const sessionKey = ii.generateIiKey();
      const registration = await fixture.register("primary", sessionKey);
      const { records, state } = memoryState();
      const session = new McpAuthStateV5(state, {
        MCP_KEY_ENCRYPTION_KEY: encryptionKey,
        KINIC_WIKI_CANISTER_ID: "6emaw-iyaaa-aaaay-aacka-cai",
        KINIC_WIKI_MCP_TARGET_ORIGIN: targetOrigin
      });
      const scope = permissions === "all" ? "mcp:read mcp:write" : "mcp:read";
      await session.createSession({
        sessionId: "primary", clientId: "client", redirectUri: "https://chatgpt.com/callback",
        oauthState: "state", scope, resource,
        codeChallenge: await sha256("v".repeat(43)), connectStateHash: await sha256("connect"),
        cookieHash: await sha256("cookie"), registrationPublicKey: "fixture", registrationKey: null,
        sessionKey: await encryptJson(sessionKey.toJSON(), encryptionKey, sessionKeyContext("primary")),
        createdAt: now, sessionCapAt: expiresAt, connectExpiresAt: now + 600_000
      });
      await session.claimConnect("connect", "cookie", now);
      const code = await session.completeConnect(registration.grantExpiresAt, registration.permissions, now, "primary");
      const first = await session.exchangeCode({ code: code!.code, clientId: "client",
        redirectUri: "https://chatgpt.com/callback", codeVerifier: "v".repeat(43), issueRefreshToken: true, now });
      const initial = await session.authenticateAccessToken(first!.accessToken, resource, now, true);
      expect(initial.kind).toBe("valid");
      if (initial.kind !== "valid" || !initial.delegation) throw new Error("Missing initial delegation");
      const originalPid = ii.restoreKinicIdentity(initial.delegation, targetOrigin, now).getPrincipal().toText();

      if (registrationMode !== "none") {
        await fixture.register(registrationMode === "same-identity" ? "primary" : "other", ii.generateIiKey());
      }
      // A previously issued delegation remains usable within its five-minute cap.
      vi.setSystemTime(now + 60_000);
      expect((await session.authenticateAccessToken(first!.accessToken, resource, Date.now(), true)).kind).toBe("valid");
      expect(minted).toHaveBeenCalledTimes(1);

      vi.setSystemTime(now + 65 * 60_000);
      expect(await session.validateAccessToken(first!.accessToken, resource, Date.now())).toBeNull();
      const rotated = await session.rotateRefreshToken({ refreshToken: first!.refreshToken!,
        clientId: "client", resource, now: Date.now() });
      // OAuth rotation alone cannot prove that II still authorizes this session key.
      expect(rotated).toMatchObject({ scope, sessionExpiresAt: expiresAt, accessExpiresAt: Date.now() + hour });
      const results = await Promise.all(Array.from({ length: 3 }, () =>
        session.authenticateAccessToken(rotated!.accessToken, resource, Date.now(), true)));
      expect(minted).toHaveBeenCalledTimes(2);
      if (registrationMode === "same-identity") {
        expect(results).toEqual([{ kind: "invalid" }, { kind: "invalid" }, { kind: "invalid" }]);
        expect(records.size).toBe(0);
        expect(await session.rotateRefreshToken({ refreshToken: rotated!.refreshToken!,
          clientId: "client", resource, now: Date.now() })).toBeNull();
      } else {
        for (const result of results) {
          expect(result).toMatchObject({ kind: "valid", scope, actionPermission: permissions });
          if (result.kind !== "valid" || !result.delegation) throw new Error("Missing renewed delegation");
          expect(ii.restoreKinicIdentity(result.delegation, targetOrigin, Date.now()).getPrincipal().toText()).toBe(originalPid);
        }
        expect(await session.validateAccessToken(rotated!.accessToken, resource, Date.now())).not.toBeNull();
      }
    }
  );
});
